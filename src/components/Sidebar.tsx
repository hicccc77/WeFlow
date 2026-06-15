import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Home, MessageSquare, BarChart3, FileText, Settings, Download, Aperture, UserCircle, Lock, LockOpen, ChevronUp, FolderClosed, Footprints, Users, ArchiveRestore, Sparkles } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import * as configService from '../services/config'
import { onExportSessionStatus, requestExportSessionStatus } from '../services/exportBridge'

import './Sidebar.scss'

interface SidebarUserProfile {
  wxid: string
  displayName: string
  alias?: string
  avatarUrl?: string
}

const SIDEBAR_USER_PROFILE_CACHE_KEY = 'sidebar_user_profile_cache_v1'
const ACCOUNT_PROFILES_CACHE_KEY = 'account_profiles_cache_v1'
const DEFAULT_DISPLAY_NAME = '微信用户'
const DEFAULT_SUBTITLE = '微信账号'

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

const readSidebarUserProfileCache = (): SidebarUserProfile | null => {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SidebarUserProfileCache
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.wxid) return null
    return {
      wxid: parsed.wxid,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
      alias: parsed.alias,
      avatarUrl: parsed.avatarUrl
    }
  } catch {
    return null
  }
}

const writeSidebarUserProfileCache = (profile: SidebarUserProfile): void => {
  if (!profile.wxid) return
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
    displayName: DEFAULT_DISPLAY_NAME
  })
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false)
  const accountCardWrapRef = useRef<HTMLDivElement | null>(null)
  const setLocked = useAppStore(state => state.setLocked)

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
    let disposed = false
    let loadSeq = 0

    const loadCurrentUser = async () => {
      const seq = ++loadSeq
      const patchUserProfile = (patch: Partial<SidebarUserProfile>) => {
        if (disposed || seq !== loadSeq) return
        setUserProfile(prev => {
          const next: SidebarUserProfile = {
            ...prev,
            ...patch
          }
          if (typeof next.displayName !== 'string' || next.displayName.length === 0) {
            next.displayName = DEFAULT_DISPLAY_NAME
          }
          writeSidebarUserProfileCache(next)
          return next
        })
      }

      try {
        const wxid = await configService.getMyWxid()
        if (disposed || seq !== loadSeq) return
        const resolvedWxidRaw = String(wxid || '').trim()
        const cleanedWxid = normalizeAccountId(resolvedWxidRaw)
        const resolvedWxid = cleanedWxid || resolvedWxidRaw

        if (!resolvedWxidRaw && !resolvedWxid) {
          window.localStorage.removeItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
          patchUserProfile({
            wxid: '',
            displayName: DEFAULT_DISPLAY_NAME,
            alias: undefined,
            avatarUrl: undefined
          })
          return
        }

        setUserProfile((prev) => {
          if (prev.wxid === resolvedWxid) return prev
          const seeded: SidebarUserProfile = {
            wxid: resolvedWxid,
            displayName: DEFAULT_DISPLAY_NAME,
            alias: undefined,
            avatarUrl: undefined
          }
          writeSidebarUserProfileCache(seeded)
          return seeded
        })

        const wxidCandidates = new Set<string>([
          resolvedWxidRaw.toLowerCase(),
          resolvedWxid.trim().toLowerCase(),
          cleanedWxid.trim().toLowerCase()
        ].filter(Boolean))

        const normalizeName = (value?: string | null): string | undefined => {
          if (typeof value !== 'string') return undefined
          if (value.length === 0) return undefined
          const lowered = value.trim().toLowerCase()
          if (lowered === 'self') return undefined
          if (lowered.startsWith('wxid_')) return undefined
          if (wxidCandidates.has(lowered)) return undefined
          return value
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
        if (disposed || seq !== loadSeq) return

        const myContact = contactResult.status === 'fulfilled' ? contactResult.value : null
        const displayName = pickFirstValidName(
          myContact?.remark,
          myContact?.nickName,
          myContact?.alias
        ) || DEFAULT_DISPLAY_NAME
        const alias = normalizeName(myContact?.alias)

        patchUserProfile({
          wxid: resolvedWxid,
          displayName,
          alias,
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
    const onWindowFocus = () => { void loadCurrentUser() }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadCurrentUser()
      }
    }
    window.addEventListener('wxid-changed', onWxidChanged as EventListener)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      loadSeq += 1
      window.removeEventListener('wxid-changed', onWxidChanged as EventListener)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const getAvatarLetter = (name: string): string => {
    if (!name) return '微'
    const visible = name.trim()
    return (visible && [...visible][0]) || '微'
  }

  const openSettingsFromAccountMenu = () => {
    setIsAccountMenuOpen(false)
    navigate('/settings', {
      state: {
        backgroundLocation: location
      }
    })
  }

  const openAccountManagement = () => {
    setIsAccountMenuOpen(false)
    navigate('/account-management')
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

          <NavLink
            to="/insight-inbox"
            className={`nav-item ${isActive('/insight-inbox') ? 'active' : ''}`}
            title={collapsed ? '灵感信箱' : undefined}
          >
            <span className="nav-icon"><Sparkles size={20} /></span>
            <span className="nav-label">灵感信箱</span>
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

          {/* 我的足迹 */}
          <NavLink
            to="/footprint"
            className={`nav-item ${isActive('/footprint') ? 'active' : ''}`}
            title={collapsed ? '我的足迹' : undefined}
          >
            <span className="nav-icon"><Footprints size={20} /></span>
            <span className="nav-label">我的足迹</span>
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

          <NavLink
            to="/backup"
            className={`nav-item ${isActive('/backup') ? 'active' : ''}`}
            title={collapsed ? '数据库备份' : undefined}
          >
            <span className="nav-icon"><ArchiveRestore size={20} /></span>
            <span className="nav-label">数据库备份</span>
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
                onClick={openAccountManagement}
                type="button"
                role="menuitem"
              >
                <Users size={14} />
                <span>账号管理</span>
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
              title={collapsed ? `${userProfile.displayName}${(userProfile.alias) ? `\n${userProfile.alias}` : ''}` : undefined}
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
                <div className="user-name">{userProfile.displayName || DEFAULT_DISPLAY_NAME}</div>
                <div className="user-wxid">{userProfile.alias || DEFAULT_SUBTITLE}</div>
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
    </>
  )
}

export default Sidebar
