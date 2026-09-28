import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useAnalyticsStore } from '../stores/analyticsStore'
import * as configService from '../services/config'
import ErrorReferenceLink from '../components/ErrorReferenceLink'
import './AccountManagementPage.scss'

interface ManagedAccountItem {
  accountId: string
  normalizedAccountId: string
  displayName: string
  avatarUrl?: string
  modifiedTime?: number
  configUpdatedAt?: number
  hasConfig: boolean
  isCurrent: boolean
  dirResolvable: boolean
}

type AccountProfileCacheEntry = {
  displayName?: string
  avatarUrl?: string
  updatedAt?: number
}

interface DeleteUndoState {
  targetAccountId: string
  deletedConfigEntries: Array<[string, configService.AccountConfig]>
  deletedProfileEntries: Array<[string, AccountProfileCacheEntry]>
  previousCurrentAccountId: string
  shouldRestoreAsCurrent: boolean
  previousDbConnected: boolean
}

type NoticeState =
  | { type: 'success' | 'error' | 'info'; text: string }
  | null

const SIDEBAR_USER_PROFILE_CACHE_KEY = 'sidebar_user_profile_cache_v1'
const ACCOUNT_PROFILES_CACHE_KEY = 'account_profiles_cache_v1'

// Keep the original storage key for backward compatibility. It now tracks both
// explicitly deleted accounts and scan-only records that have no usable config.
const HIDDEN_ACCOUNT_NORM_IDS_KEY = 'weflow_account_mgmt_hidden_deleted_norm_v1'

const readHiddenAccountNormIds = (): Set<string> => {
  try {
    const raw = window.localStorage.getItem(HIDDEN_ACCOUNT_NORM_IDS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string' && x.length > 0))
  } catch {
    return new Set()
  }
}

const writeHiddenAccountNormIds = (ids: Set<string>): void => {
  try {
    window.localStorage.setItem(HIDDEN_ACCOUNT_NORM_IDS_KEY, JSON.stringify(Array.from(ids)))
  } catch {
    
  }
}

const addHiddenAccountNormId = (normalized: string): void => {
  if (!normalized) return
  const next = readHiddenAccountNormIds()
  next.add(normalized)
  writeHiddenAccountNormIds(next)
}

const removeHiddenAccountNormId = (normalized: string): void => {
  if (!normalized) return
  const next = readHiddenAccountNormIds()
  if (!next.delete(normalized)) return
  writeHiddenAccountNormIds(next)
}

const DEFAULT_ACCOUNT_DISPLAY_NAME = '用户'

const normalizeAccountId = (value?: string | null): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('accountId_')) {
    const match = trimmed.match(/^(accountId_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

const resolveAccountDisplayName = (
  candidates: Array<unknown>,
  accountIdCandidates: Set<string>
): string => {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (candidate.length === 0) continue
    const normalized = candidate.trim().toLowerCase()
    if (normalized.startsWith('accountId_')) continue
    if (normalized && accountIdCandidates.has(normalized)) continue
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
  const [currentAccountId, setCurrentAccountId] = useState('')
  const [accounts, setAccounts] = useState<ManagedAccountItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [workingAccountId, setWorkingAccountId] = useState('')
  const [notice, setNotice] = useState<NoticeState>(null)
  const [deleteUndoState, setDeleteUndoState] = useState<DeleteUndoState | null>(null)

  const loadAccounts = useCallback(async () => {
    setIsLoading(true)
    try {
      const [path, rawCurrentAccountId, accountConfigs] = await Promise.all([
        configService.getDbPath(),
        configService.getMyAccountId(),
        configService.getAccountConfigs()
      ])
      const nextDbPath = String(path || '').trim()
      const nextCurrentAccountId = String(rawCurrentAccountId || '').trim()
      const normalizedCurrent = normalizeAccountId(nextCurrentAccountId) || nextCurrentAccountId
      setDbPath(nextDbPath)
      setCurrentAccountId(nextCurrentAccountId)

      const accountProfileCache = readAccountProfilesCache()
      const configEntries = Object.entries(accountConfigs || {})
      const configByNormalized = new Map<string, { key: string; value: configService.AccountConfig }>()
      for (const [accountId, cfg] of configEntries) {
        const normalized = normalizeAccountId(accountId) || accountId
        if (!normalized) continue
        const previous = configByNormalized.get(normalized)
        if (!previous || Number(cfg?.updatedAt || 0) > Number(previous.value?.updatedAt || 0)) {
          configByNormalized.set(normalized, { key: accountId, value: cfg || {} })
        }
      }

      const merged = new Map<string, ManagedAccountItem>()
      for (const [normalized, matchedConfig] of configByNormalized.entries()) {
        if (merged.has(normalized)) continue
        const accountId = matchedConfig.key
        const cached = accountProfileCache[accountId] || accountProfileCache[normalized]
        const accountIdCandidates = new Set<string>([
          String(accountId || '').trim().toLowerCase(),
          String(normalized || '').trim().toLowerCase()
        ].filter(Boolean))
        const displayName = resolveAccountDisplayName(
          [cached?.displayName],
          accountIdCandidates
        )
        merged.set(normalized, {
          accountId,
          normalizedAccountId: normalized,
          displayName,
          avatarUrl: cached?.avatarUrl,
          modifiedTime: 0,
          configUpdatedAt: Number(matchedConfig.value?.updatedAt || 0),
          hasConfig: true,
          isCurrent: Boolean(normalizedCurrent) && normalized === normalizedCurrent,
          dirResolvable: false
        })
      }

      // 校验每个账号目录是否真的能在 dbPath 下解析到，决定是否允许"切换账号"。
      if (nextDbPath) {
        await Promise.all(Array.from(merged.values()).map(async (item) => {
          try {
            const result = await window.electronAPI.account.resolveDir(nextDbPath, item.accountId)
            if (result.accountDir) {
              const target = merged.get(item.normalizedAccountId)
              if (target) target.dirResolvable = true
            }
          } catch { /* ignore */ }
        }))
      }

      // 账号管理只展示真实可管理的配置。没有保存配置的目录记录无法切换、
      // 也没有配置可删除，因此自动清理出列表；后续完成配置后会自动恢复展示。
      const hiddenAccountNormIds = readHiddenAccountNormIds()
      let hiddenAccountStateChanged = false
      for (const [normalized, item] of Array.from(merged.entries())) {
        if (!item.hasConfig) {
          if (!hiddenAccountNormIds.has(normalized)) {
            hiddenAccountNormIds.add(normalized)
            hiddenAccountStateChanged = true
          }
          merged.delete(normalized)
          continue
        }

        if (hiddenAccountNormIds.delete(normalized)) {
          hiddenAccountStateChanged = true
        }
      }
      if (hiddenAccountStateChanged) {
        writeHiddenAccountNormIds(hiddenAccountNormIds)
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
    const onAccountIdChanged = () => { void loadAccounts() }
    const onWindowFocus = () => { void loadAccounts() }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadAccounts()
      }
    }
    window.addEventListener('accountId-changed', onAccountIdChanged as EventListener)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('accountId-changed', onAccountIdChanged as EventListener)
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

  const applyAccountConfig = useCallback(async (accountId: string, accountConfig: configService.AccountConfig | null) => {
    await configService.setMyAccountId(accountId)
    await configService.setDecryptKey(accountConfig?.decryptKey || '')
    await configService.setImageXorKey(typeof accountConfig?.imageXorKey === 'number' ? accountConfig.imageXorKey : 0)
    await configService.setImageAesKey(accountConfig?.imageAesKey || '')
  }, [])

  const handleSwitchAccount = useCallback(async (accountId: string) => {
    if (!accountId || workingAccountId) return
    const targetNormalized = normalizeAccountId(accountId) || accountId
    const currentNormalized = normalizeAccountId(currentAccountId) || currentAccountId
    if (targetNormalized && currentNormalized && targetNormalized === currentNormalized) return

    setWorkingAccountId(`switch:${accountId}`)
    setNotice(null)
    setDeleteUndoState(null)
    try {
      const allConfigs = await configService.getAccountConfigs()
      const configEntries = Object.entries(allConfigs || {})
      const matched = configEntries.find(([key]) => {
        const normalized = normalizeAccountId(key) || key
        return key === accountId || normalized === targetNormalized
      })
      const targetConfig = matched?.[1] || null
      await applyAccountConfig(accountId, targetConfig)
      await clearRuntimeCacheState()
      window.dispatchEvent(new CustomEvent('accountId-changed', { detail: { accountId } }))
      setNotice({ type: 'success', text: `已切换到账号「${accountId}」` })
      await loadAccounts()
    } catch (error) {
      console.error('切换账号失败:', error)
      setNotice({ type: 'error', text: '切换账号失败，请稍后重试' })
    } finally {
      setWorkingAccountId('')
    }
  }, [applyAccountConfig, clearRuntimeCacheState, currentAccountId, loadAccounts, workingAccountId])

  const handleAddAccount = useCallback(async () => {
    if (workingAccountId) return
    setNotice(null)
    setDeleteUndoState(null)
    try {
      await window.electronAPI.window.openOnboardingWindow({ mode: 'add-account' })
      await loadAccounts()
      const latestAccountId = String(await configService.getMyAccountId() || '').trim()
      window.dispatchEvent(new CustomEvent('accountId-changed', { detail: { accountId: latestAccountId } }))
    } catch (error) {
      console.error('打开添加账号引导失败:', error)
      setNotice({ type: 'error', text: '打开添加账号引导失败，请稍后重试' })
    }
  }, [loadAccounts, workingAccountId])

  const handleDeleteAccountConfig = useCallback(async (targetAccountId: string) => {
    if (!targetAccountId || workingAccountId) return

    const normalizedTarget = normalizeAccountId(targetAccountId) || targetAccountId

    setWorkingAccountId(`delete:${targetAccountId}`)
    setNotice(null)
    setDeleteUndoState(null)
    try {
      const allConfigs = await configService.getAccountConfigs()
      const nextConfigs: Record<string, configService.AccountConfig> = { ...allConfigs }
      const matchedKeys = Object.keys(nextConfigs).filter((key) => {
        const normalized = normalizeAccountId(key) || key
        return key === targetAccountId || normalized === normalizedTarget
      })

      if (matchedKeys.length === 0) {
        setNotice({ type: 'info', text: `账号「${targetAccountId}」暂无可删除配置` })
        return
      }

      const deletedConfigEntries: Array<[string, configService.AccountConfig]> = matchedKeys.map((key) => [key, nextConfigs[key] || {}])
      for (const key of matchedKeys) {
        delete nextConfigs[key]
      }
      await configService.setAccountConfigs(nextConfigs)

      const accountProfileCache = readAccountProfilesCache()
      const deletedProfileEntries: Array<[string, AccountProfileCacheEntry]> = []
      for (const key of Object.keys(accountProfileCache)) {
        const normalized = normalizeAccountId(key) || key
        if (key === targetAccountId || normalized === normalizedTarget) {
          deletedProfileEntries.push([key, accountProfileCache[key]])
          delete accountProfileCache[key]
        }
      }
      window.localStorage.setItem(ACCOUNT_PROFILES_CACHE_KEY, JSON.stringify(accountProfileCache))

      const currentNormalized = normalizeAccountId(currentAccountId) || currentAccountId
      const isDeletingCurrent = Boolean(currentNormalized && currentNormalized === normalizedTarget)
      const undoPayload: DeleteUndoState = {
        targetAccountId,
        deletedConfigEntries,
        deletedProfileEntries,
        previousCurrentAccountId: currentAccountId,
        shouldRestoreAsCurrent: isDeletingCurrent,
        previousDbConnected: isDbConnected
      }

      if (isDeletingCurrent) {
        await clearRuntimeCacheState()

        const remainingEntries = Object.entries(nextConfigs)
          .filter(([accountId]) => Boolean(String(accountId || '').trim()))
          .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))

        if (remainingEntries.length > 0) {
          const [nextAccountId, nextConfig] = remainingEntries[0]
          await applyAccountConfig(nextAccountId, nextConfig || null)
          window.dispatchEvent(new CustomEvent('accountId-changed', { detail: { accountId: nextAccountId } }))
          addHiddenAccountNormId(normalizedTarget)
          setDeleteUndoState(undoPayload)
          setNotice({ type: 'success', text: `已删除「${targetAccountId}」配置，并切换到「${nextAccountId}」` })
          await loadAccounts()
          return
        }

        await configService.setMyAccountId('')
        await configService.setDecryptKey('')
        await configService.setImageXorKey(0)
        await configService.setImageAesKey('')
        setDbConnected(false)
        window.dispatchEvent(new CustomEvent('accountId-changed', { detail: { accountId: '' } }))
        addHiddenAccountNormId(normalizedTarget)
        setDeleteUndoState(undoPayload)
        setNotice({ type: 'info', text: `已删除「${targetAccountId}」配置，当前无可用账号配置，可撤回或添加账号` })
        await loadAccounts()
        return
      }

      addHiddenAccountNormId(normalizedTarget)
      setDeleteUndoState(undoPayload)
      setNotice({ type: 'success', text: `已删除账号「${targetAccountId}」配置` })
      await loadAccounts()
    } catch (error) {
      console.error('删除账号配置失败:', error)
      setNotice({ type: 'error', text: '删除账号配置失败，请稍后重试' })
    } finally {
      setWorkingAccountId('')
    }
  }, [applyAccountConfig, clearRuntimeCacheState, currentAccountId, isDbConnected, loadAccounts, setDbConnected, workingAccountId])

  const handleUndoDelete = useCallback(async () => {
    if (!deleteUndoState || workingAccountId) return

    setWorkingAccountId(`undo:${deleteUndoState.targetAccountId}`)
    setNotice(null)
    try {
      const currentConfigs = await configService.getAccountConfigs()
      const restoredConfigs: Record<string, configService.AccountConfig> = { ...currentConfigs }
      for (const [key, configValue] of deleteUndoState.deletedConfigEntries) {
        restoredConfigs[key] = configValue || {}
      }
      await configService.setAccountConfigs(restoredConfigs)
      removeHiddenAccountNormId(normalizeAccountId(deleteUndoState.targetAccountId) || deleteUndoState.targetAccountId)

      const accountProfileCache = readAccountProfilesCache()
      for (const [key, profile] of deleteUndoState.deletedProfileEntries) {
        accountProfileCache[key] = profile
      }
      window.localStorage.setItem(ACCOUNT_PROFILES_CACHE_KEY, JSON.stringify(accountProfileCache))

      if (deleteUndoState.shouldRestoreAsCurrent && deleteUndoState.previousCurrentAccountId) {
        const previousNormalized = normalizeAccountId(deleteUndoState.previousCurrentAccountId) || deleteUndoState.previousCurrentAccountId
        const restoreConfigEntry = Object.entries(restoredConfigs)
          .filter(([key]) => {
            const normalized = normalizeAccountId(key) || key
            return key === deleteUndoState.previousCurrentAccountId || normalized === previousNormalized
          })
          .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))[0]
        const restoreConfig = restoreConfigEntry?.[1] || null

        await clearRuntimeCacheState()
        await applyAccountConfig(deleteUndoState.previousCurrentAccountId, restoreConfig)
        if (deleteUndoState.previousDbConnected) {
          setDbConnected(true, dbPath || undefined)
        }
        window.dispatchEvent(new CustomEvent('accountId-changed', { detail: { accountId: deleteUndoState.previousCurrentAccountId } }))
      }

      setNotice({ type: 'success', text: `已撤回删除，账号「${deleteUndoState.targetAccountId}」配置已恢复` })
      setDeleteUndoState(null)
      await loadAccounts()
    } catch (error) {
      console.error('撤回删除失败:', error)
      setNotice({ type: 'error', text: '撤回删除失败，请稍后重试' })
    } finally {
      setWorkingAccountId('')
    }
  }, [applyAccountConfig, clearRuntimeCacheState, dbPath, deleteUndoState, loadAccounts, setDbConnected, workingAccountId])

  const currentAccount = useMemo(
    () => accounts.find(account => account.isCurrent),
    [accounts]
  )

  const currentAccountLabel = currentAccount?.displayName || (currentAccountId ? '账号' : '未设置')

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
    <div className="account-management-page" aria-busy={isLoading || Boolean(workingAccountId)}>
      <div className="account-management-shell">
        <header className="account-management-header">
          <div className="account-management-heading">
            <h1>账号管理</h1>
          </div>
          <div className="account-management-actions">
            <button
              type="button"
              className="btn btn-secondary account-refresh-button"
              onClick={() => void loadAccounts()}
              disabled={isLoading || Boolean(workingAccountId)}
            >
              {isLoading && <Loader2 size={16} className="account-spin" aria-hidden="true" />}
              {isLoading ? '正在刷新' : '刷新'}
            </button>
            <button type="button" className="btn btn-primary account-add-button" onClick={handleAddAccount} disabled={Boolean(workingAccountId)}>
              添加账号
            </button>
          </div>
        </header>

        <section className="account-management-summary" aria-label="账号概览">
          <article className="summary-item summary-path">
            <div className="summary-content">
              <span className="summary-label">数据源</span>
              <span className="summary-value summary-path-value" title={dbPath || '未配置'}>{dbPath || '未配置数据库目录'}</span>
            </div>
          </article>
          <article className="summary-item">
            <div className="summary-content">
              <span className="summary-label">当前账号</span>
              <span className="summary-value">{currentAccountLabel}</span>
              <span className="summary-account-id" title={currentAccountId || undefined}>{currentAccountId || '尚未选择账号'}</span>
            </div>
          </article>
          <article className="summary-item summary-count">
            <div className="summary-content">
              <span className="summary-label">可用账号</span>
              <span className="summary-value summary-number">{accounts.length}</span>
            </div>
          </article>
        </section>

        {notice && (
          <div
            className={`account-notice ${notice.type}`}
            role={notice.type === 'error' ? 'alert' : 'status'}
            aria-live={notice.type === 'error' ? 'assertive' : 'polite'}
          >
            <div className="notice-content">
              <span>{notice.text}</span>
            </div>
            <div className="notice-actions">
              {notice.type === 'error' && (
                <ErrorReferenceLink error={notice.text} label="核对" compact />
              )}
              {deleteUndoState && (notice.type === 'success' || notice.type === 'info') && (
                <button
                  type="button"
                  className="notice-action"
                  onClick={() => void handleUndoDelete()}
                  disabled={Boolean(workingAccountId)}
                >
                  撤回删除
                </button>
              )}
            </div>
          </div>
        )}

        <section className="account-list-section" aria-labelledby="account-list-title">
          <div className="account-list-header">
            <h2 id="account-list-title">账号列表</h2>
            <span className="account-list-count">{accounts.length} 个可用账号</span>
          </div>

          {accounts.length === 0 ? (
            <div className="account-empty">
              <div className="account-empty-copy">
                <h3>还没有可管理的账号</h3>
                <p>添加账号后即可在这里切换。</p>
              </div>
              <button type="button" className="btn btn-primary account-empty-action" onClick={handleAddAccount} disabled={Boolean(workingAccountId)}>
                添加账号
              </button>
            </div>
          ) : (
            <div className="account-list">
              {accounts.map((account) => {
                const switchingAccount = workingAccountId === `switch:${account.accountId}`
                const deletingAccount = workingAccountId === `delete:${account.accountId}`

                return (
                  <article
                    key={account.normalizedAccountId}
                    className={`account-row ${account.isCurrent ? 'is-current' : ''}`}
                    aria-current={account.isCurrent ? 'true' : undefined}
                    aria-busy={switchingAccount || deletingAccount}
                  >
                    <div className="account-avatar">
                      {account.avatarUrl
                        ? <img src={account.avatarUrl} alt={`${account.displayName}的头像`} />
                        : <span aria-hidden="true">{resolveAccountAvatarText(account.displayName)}</span>}
                    </div>

                    <div className="account-main">
                      <div className="account-title-row">
                        <h3>{account.displayName}</h3>
                        {!account.dirResolvable && (
                          <span className="account-state muted">本地数据缺失</span>
                        )}
                      </div>

                      <div className="account-id" title={account.accountId}>
                        <span>账号 ID</span>
                        <code>{account.accountId}</code>
                      </div>

                      <div className="account-details">
                        <div className="account-detail">
                          <span><strong>数据更新</strong>{formatTime(account.modifiedTime)}</span>
                        </div>
                        <div className="account-detail">
                          <span><strong>配置更新</strong>{formatTime(account.configUpdatedAt)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="account-row-actions">
                      {account.isCurrent ? (
                        <span className="account-current-indicator">当前使用</span>
                      ) : account.dirResolvable ? (
                        <button
                          type="button"
                          className="btn account-switch-button"
                          onClick={() => void handleSwitchAccount(account.accountId)}
                          disabled={Boolean(workingAccountId)}
                          aria-label={`切换到账号：${account.displayName}`}
                        >
                          {switchingAccount && <Loader2 size={15} className="account-spin" aria-hidden="true" />}
                          {switchingAccount ? '正在切换' : '切换账号'}
                        </button>
                      ) : (
                        <span className="account-unavailable-indicator">数据不可用</span>
                      )}
                      <button
                        type="button"
                        className="btn btn-danger account-delete-button"
                        onClick={() => void handleDeleteAccountConfig(account.accountId)}
                        disabled={Boolean(workingAccountId)}
                        aria-label={`删除${account.displayName}的本地配置`}
                      >
                        {deletingAccount && <Loader2 size={15} className="account-spin" aria-hidden="true" />}
                        {deletingAccount ? '正在删除' : '删除配置'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <footer className="account-management-footer">
          删除配置不会影响原始数据。
        </footer>
      </div>
    </div>
  )
}

export default AccountManagementPage
