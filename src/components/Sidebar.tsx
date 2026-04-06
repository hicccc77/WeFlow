import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Home, MessageSquare, BarChart3, FileText, Settings, Download, Aperture, UserCircle, Lock, LockOpen, ChevronUp, RefreshCw, FolderClosed } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useAnalyticsStore } from '../stores/analyticsStore'
import * as configService from '../services/config'
import { onExportSessionStatus, requestExportSessionStatus } from '../services/exportBridge'
import { UserRound } from 'lucide-react'

import './Sidebar.scss'

interface SidebarUserProfile {
  wxid: string
  displayName: string
  alias?: string
  avatarUrl?: string
}

const SIDEBAR_USER_PROFILE_CACHE_KEY = 'sidebar_user_profile_cache_v1'
const ACCOUNT_PROFILES_CACHE_KEY = 'account_profiles_cache_v1'

interface SidebarUserProfileCache extends SidebarUserProfile {
  updatedAt: number
}

interface AccountProfilesCache {
  [wxid: string]: {
    displayName: string
    avatarUrl?: string
    alias?: string
    updatedAt: number
  }
}

interface WxidOption {
  wxid: string
  modifiedTime: number
  nickname?: string
  displayName?: string
  avatarUrl?: string
}

const readSidebarUserProfileCache = (): SidebarUserProfile | null => {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SidebarUserProfileCache
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.wxid || !parsed.displayName) return null
    return {
      wxid: parsed.wxid,
      displayName: parsed.displayName,
      alias: parsed.alias,
      avatarUrl: parsed.avatarUrl
    }
  } catch {
    return null
  }
}

const writeSidebarUserProfileCache = (profile: SidebarUserProfile): void => {
  if (!profile.wxid || !profile.displayName) return
  try {
    const payload: SidebarUserProfileCache = {
      ...profile,
      updatedAt: Date.now()
    }
    window.localStorage.setItem(SIDEBAR_USER_PROFILE_CACHE_KEY, JSON.stringify(payload))

    // 同时写入账号缓存池
    const accountsCache = readAccountProfilesCache()
    accountsCache[profile.wxid] = {
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      alias: profile.alias,
      updatedAt: Date.now()
    }
    window.localStorage.setItem(ACCOUNT_PROFILES_CACHE_KEY, JSON.stringify(accountsCache))
  } catch {
    // 忽略本地缓存失败，不影响主流程
  }
}

const readAccountProfilesCache = (): AccountProfilesCache => {
  try {
    const raw = window.localStorage.getItem(ACCOUNT_PROFILES_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

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

interface SidebarProps {
  collapsed: boolean
}

function Sidebar({ collapsed }: SidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [authEnabled, setAuthEnabled] = useState(false)
  const [activeExportTaskCount, setActiveExportTaskCount] = useState(0)
  const [userProfile, setUserProfile] = useState<SidebarUserProfile>({
    wxid: '',
    displayName: '未识别用户'
  })
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false)
  const [showSwitchAccountDialog, setShowSwitchAccountDialog] = useState(false)
  const [wxidOptions, setWxidOptions] = useState<WxidOption[]>([])
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false)
  const accountCardWrapRef = useRef<HTMLDivElement | null>(null)
  const setLocked = useAppStore(state => state.setLocked)
  const isDbConnected = useAppStore(state => state.isDbConnected)
  const resetChatStore = useChatStore(state => state.reset)
  const clearAnalyticsStoreCache = useAnalyticsStore(state => state.clearCache)

  useEffect(() => {
    window.electronAPI.auth.verifyEnabled().then(setAuthEnabled)
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!isAccountMenuOpen) return
      const target = event.target as Node | null
      if (accountCardWrapRef.current && target && !accountCardWrapRef.current.contains(target)) {
        setIsAccountMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isAccountMenuOpen])

  useEffect(() => {
    const unsubscribe = onExportSessionStatus((payload) => {
      const countFromPayload = typeof payload?.activeTaskCount === 'number'
        ? payload.activeTaskCount
        : Array.isArray(payload?.inProgressSessionIds)
          ? payload.inProgressSessionIds.length
          : 0
      const normalized = Math.max(0, Math.floor(countFromPayload))
      setActiveExportTaskCount(normalized)
    })

    requestExportSessionStatus()
    const timer = window.setTimeout(() => requestExportSessionStatus(), 120)

    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const loadCurrentUser = async () => {
      const patchUserProfile = (patch: Partial<SidebarUserProfile>, expectedWxid?: string) => {
        setUserProfile(prev => {
          if (expectedWxid && prev.wxid && prev.wxid !== expectedWxid) {
            return prev
          }
          const next: SidebarUserProfile = {
            ...prev,
            ...patch
          }
          if (!next.displayName) {
            next.displayName = next.wxid || '未识别用户'
          }
          writeSidebarUserProfileCache(next)
          return next
        })
      }

      try {
        const wxid = await configService.getMyWxid()
        const resolvedWxidRaw = String(wxid || '').trim()
        const cleanedWxid = normalizeAccountId(resolvedWxidRaw)
        const resolvedWxid = cleanedWxid || resolvedWxidRaw

        if (!resolvedWxidRaw && !resolvedWxid) return

        const wxidCandidates = new Set<string>([
          resolvedWxidRaw.toLowerCase(),
          resolvedWxid.trim().toLowerCase(),
          cleanedWxid.trim().toLowerCase()
        ].filter(Boolean))

        const normalizeName = (value?: string | null): string | undefined => {
          if (!value) return undefined
          const trimmed = value.trim()
          if (!trimmed) return undefined
          const lowered = trimmed.toLowerCase()
          if (lowered === 'self') return undefined
          if (lowered.startsWith('wxid_')) return undefined
          if (wxidCandidates.has(lowered)) return undefined
          return trimmed
        }

        const pickFirstValidName = (...candidates: Array<string | null | undefined>): string | undefined => {
          for (const candidate of candidates) {
            const normalized = normalizeName(candidate)
            if (normalized) return normalized
          }
          return undefined
        }

        // 并行获取名称和头像
        const [contactResult, avatarResult] = await Promise.allSettled([
          (async () => {
            const candidates = Array.from(new Set([resolvedWxidRaw, resolvedWxid, cleanedWxid].filter(Boolean)))
            for (const candidate of candidates) {
              const contact = await window.electronAPI.chat.getContact(candidate)
              if (contact?.remark || contact?.nickName || contact?.alias) {
                return contact
              }
            }
            return null
          })(),
          window.electronAPI.chat.getMyAvatarUrl()
        ])

        const myContact = contactResult.status === 'fulfilled' ? contactResult.value : null
        const displayName = pickFirstValidName(
          myContact?.remark,
          myContact?.nickName,
          myContact?.alias
        ) || resolvedWxid || '未识别用户'

        patchUserProfile({
          wxid: resolvedWxid,
          displayName,
          alias: myContact?.alias,
          avatarUrl: avatarResult.status === 'fulfilled' && avatarResult.value.success
            ? avatarResult.value.avatarUrl
            : undefined
        })
      } catch (error) {
        console.error('加载侧边栏用户信息失败:', error)
      }
    }

    const cachedProfile = readSidebarUserProfileCache()
    if (cachedProfile) {
      setUserProfile(cachedProfile)
    }

    void loadCurrentUser()
    const onWxidChanged = () => { void loadCurrentUser() }
    window.addEventListener('wxid-changed', onWxidChanged as EventListener)
    return () => window.removeEventListener('wxid-changed', onWxidChanged as EventListener)
  }, [])

  const getAvatarLetter = (name: string): string => {
    if (!name) return '?'
    return [...name][0] || '?'
  }

  const openSwitchAccountDialog = async () => {
    setIsAccountMenuOpen(false)
    if (!isDbConnected) {
      window.alert('数据库未连接，无法切换账号')
      return
    }
    const dbPath = await configService.getDbPath()
    if (!dbPath) {
      window.alert('请先在设置中配置数据库路径')
      return
    }
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      const accountsCache = readAccountProfilesCache()
      console.log('[切换账号] 账号缓存:', accountsCache)

      const enrichedWxids = wxids.map((option: WxidOption) => {
        const normalizedWxid = normalizeAccountId(option.wxid)
        const cached = accountsCache[option.wxid] || accountsCache[normalizedWxid]

        let displayName = option.nickname || option.wxid
        let avatarUrl = option.avatarUrl

        if (option.wxid === userProfile.wxid || normalizedWxid === userProfile.wxid) {
          displayName = userProfile.displayName || displayName
          avatarUrl = userProfile.avatarUrl || avatarUrl
        }

        else if (cached) {
          displayName = cached.displayName || displayName
          avatarUrl = cached.avatarUrl || avatarUrl
        }

        return {
          ...option,
          displayName,
          avatarUrl
        }
      })

      setWxidOptions(enrichedWxids)
      setShowSwitchAccountDialog(true)
    } catch (error) {
      console.error('扫描账号失败:', error)
      window.alert('扫描账号失败，请稍后重试')
    }
  }

  const handleSwitchAccount = async (selectedWxid: string) => {
    if (!selectedWxid || isSwitchingAccount) return
    setIsSwitchingAccount(true)
    try {
      console.log('[切换账号] 开始切换到:', selectedWxid)
      const currentWxid = userProfile.wxid
      if (currentWxid === selectedWxid) {
        console.log('[切换账号] 已经是当前账号，跳过')
        setShowSwitchAccountDialog(false)
        setIsSwitchingAccount(false)
        return
      }

      console.log('[切换账号] 设置新 wxid')
      await configService.setMyWxid(selectedWxid)

      console.log('[切换账号] 获取账号配置')
      const wxidConfig = await configService.getWxidConfig(selectedWxid)
      console.log('[切换账号] 配置内容:', wxidConfig)
      if (wxidConfig?.decryptKey) {
        console.log('[切换账号] 设置 decryptKey')
        await configService.setDecryptKey(wxidConfig.decryptKey)
      }
      if (typeof wxidConfig?.imageXorKey === 'number') {
        console.log('[切换账号] 设置 imageXorKey:', wxidConfig.imageXorKey)
        await configService.setImageXorKey(wxidConfig.imageXorKey)
      }
      if (wxidConfig?.imageAesKey) {
        console.log('[切换账号] 设置 imageAesKey')
        await configService.setImageAesKey(wxidConfig.imageAesKey)
      }

      console.log('[切换账号] 检查数据库连接状态')
      console.log('[切换账号] 数据库连接状态:', isDbConnected)
      if (isDbConnected) {
        console.log('[切换账号] 关闭数据库连接')
        await window.electronAPI.chat.close()
      }

      console.log('[切换账号] 清除缓存')
      window.localStorage.removeItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
      clearAnalyticsStoreCache()
      resetChatStore()

      console.log('[切换账号] 触发 wxid-changed 事件')
      window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: selectedWxid } }))

      console.log('[切换账号] 切换成功')
      setShowSwitchAccountDialog(false)
    } catch (error) {
      console.error('[切换账号] 失败:', error)
      window.alert('切换账号失败，请稍后重试')
    } finally {
      setIsSwitchingAccount(false)
    }
  }

  const openSettingsFromAccountMenu = () => {
    setIsAccountMenuOpen(false)
    navigate('/settings', {
      state: {
        backgroundLocation: location
      }
    })
  }

  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(`${path}/`)
  }
  const exportTaskBadge = activeExportTaskCount > 99 ? '99+' : `${activeExportTaskCount}`

  return (
    <>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <nav className="nav-menu">
          {/* 首页 */}
          <NavLink
            to="/home"
            className={`nav-item ${isActive('/home') ? 'active' : ''}`}
            title={collapsed ? '首页' : undefined}
          >
            <span className="nav-icon"><Home size={20} /></span>
            <span className="nav-label">首页</span>
          </NavLink>

          {/* 聊天 */}
          <NavLink
            to="/chat"
            className={`nav-item ${isActive('/chat') ? 'active' : ''}`}
            title={collapsed ? '聊天' : undefined}
          >
            <span className="nav-icon"><MessageSquare size={20} /></span>
            <span className="nav-label">聊天</span>
          </NavLink>

          {/* 朋友圈 */}
          <NavLink
            to="/sns"
            className={`nav-item ${isActive('/sns') ? 'active' : ''}`}
            title={collapsed ? '朋友圈' : undefined}
          >
            <span className="nav-icon"><Aperture size={20} /></span>
            <span className="nav-label">朋友圈</span>
          </NavLink>

          {/* 通讯录 */}
          <NavLink
            to="/contacts"
            className={`nav-item ${isActive('/contacts') ? 'active' : ''}`}
            title={collapsed ? '通讯录' : undefined}
          >
            <span className="nav-icon"><UserCircle size={20} /></span>
            <span className="nav-label">通讯录</span>
          </NavLink>

          {/* 资源浏览 */}
          <NavLink
            to="/resources"
            className={`nav-item ${isActive('/resources') ? 'active' : ''}`}
            title={collapsed ? '资源浏览' : undefined}
          >
            <span className="nav-icon"><FolderClosed size={20} /></span>
            <span className="nav-label">资源浏览</span>
          </NavLink>

          {/* 聊天分析 */}
          <NavLink
            to="/analytics"
            className={`nav-item ${isActive('/analytics') ? 'active' : ''}`}
            title={collapsed ? '聊天分析' : undefined}
          >
            <span className="nav-icon"><BarChart3 size={20} /></span>
            <span className="nav-label">聊天分析</span>
          </NavLink>

          {/* 年度报告 */}
          <NavLink
            to="/annual-report"
            className={`nav-item ${isActive('/annual-report') ? 'active' : ''}`}
            title={collapsed ? '年度报告' : undefined}
          >
            <span className="nav-icon"><FileText size={20} /></span>
            <span className="nav-label">年度报告</span>
          </NavLink>

          {/* 导出 */}
          <NavLink
            to="/export"
            className={`nav-item ${isActive('/export') ? 'active' : ''}`}
            title={collapsed ? '导出' : undefined}
          >
            <span className="nav-icon nav-icon-with-badge">
              <Download size={20} />
              {collapsed && activeExportTaskCount > 0 && (
                <span className="nav-badge icon-badge">{exportTaskBadge}</span>
              )}
            </span>
            <span className="nav-label">导出</span>
            {!collapsed && activeExportTaskCount > 0 && (
              <span className="nav-badge">{exportTaskBadge}</span>
            )}
          </NavLink>


        </nav>

        <div className="sidebar-footer">
          <button
            className="nav-item"
            onClick={() => {
              if (authEnabled) {
                setLocked(true)
                return
              }
              navigate('/settings', {
                state: {
                  initialTab: 'security',
                  backgroundLocation: location
                }
              })
            }}
            title={collapsed ? (authEnabled ? '锁定' : '未锁定') : undefined}
          >
            <span className="nav-icon">{authEnabled ? <Lock size={20} /> : <LockOpen size={20} />}</span>
            <span className="nav-label">{authEnabled ? '锁定' : '未锁定'}</span>
          </button>

          <div className="sidebar-user-card-wrap" ref={accountCardWrapRef}>
            <div className={`sidebar-user-menu ${isAccountMenuOpen ? 'open' : ''}`} role="menu" aria-label="账号菜单">
              <button
                className="sidebar-user-menu-item"
                onClick={openSwitchAccountDialog}
                type="button"
                role="menuitem"
              >
                <RefreshCw size={14} />
                <span>切换账号</span>
              </button>
              <button
                className="sidebar-user-menu-item"
                onClick={openSettingsFromAccountMenu}
                type="button"
                role="menuitem"
              >
                <Settings size={14} />
                <span>设置</span>
              </button>
            </div>
            <div
              className={`sidebar-user-card ${isAccountMenuOpen ? 'menu-open' : ''}`}
              title={collapsed ? `${userProfile.displayName}${(userProfile.alias || userProfile.wxid) ? `\n${userProfile.alias || userProfile.wxid}` : ''}` : undefined}
              onClick={() => setIsAccountMenuOpen(prev => !prev)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setIsAccountMenuOpen(prev => !prev)
                }
              }}
            >
              <div className="user-avatar">
                {userProfile.avatarUrl ? <img src={userProfile.avatarUrl} alt="" /> : <span>{getAvatarLetter(userProfile.displayName)}</span>}
              </div>
              <div className="user-meta">
                <div className="user-name">{userProfile.displayName}</div>
                <div className="user-wxid">{userProfile.alias || userProfile.wxid || 'wxid 未识别'}</div>
              </div>
              {!collapsed && (
                <span className={`user-menu-caret ${isAccountMenuOpen ? 'open' : ''}`}>
                  <ChevronUp size={14} />
                </span>
              )}
            </div>
          </div>
        </div>
      </aside>

      {showSwitchAccountDialog && (
        <div className="sidebar-dialog-overlay" onClick={() => !isSwitchingAccount && setShowSwitchAccountDialog(false)}>
          <div className="sidebar-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>切换账号</h3>
            <p>选择要切换的微信账号</p>
            <div className="sidebar-wxid-list">
              {wxidOptions.map((option) => (
                <button
                  key={option.wxid}
                  className={`sidebar-wxid-item ${userProfile.wxid === option.wxid ? 'current' : ''}`}
                  onClick={() => handleSwitchAccount(option.wxid)}
                  disabled={isSwitchingAccount}
                  type="button"
                >
                  <div className="wxid-avatar">
                    {option.avatarUrl ? (
                        <img src={option.avatarUrl} alt="" />
                    ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)', borderRadius: '6px', color: 'var(--text-tertiary)' }}>
                          <UserRound size={16} />
                        </div>
                    )}
                  </div>
                  <div className="wxid-info">
                    <div className="wxid-name">{option.displayName}</div>
                    {option.displayName !== option.wxid && <div className="wxid-id">{option.wxid}</div>}
                  </div>
                  {userProfile.wxid === option.wxid && <span className="current-badge">当前</span>}
                </button>
              ))}
            </div>
            <div className="sidebar-dialog-actions">
              <button type="button" onClick={() => setShowSwitchAccountDialog(false)} disabled={isSwitchingAccount}>取消</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default Sidebar
