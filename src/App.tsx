import { useEffect, useState } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import RouteGuard from './components/RouteGuard'
import WelcomePage from './pages/WelcomePage'
import HomePage from './pages/HomePage'
import ChatPage from './pages/ChatPage'
import AnalyticsPage from './pages/AnalyticsPage'
import AnalyticsWelcomePage from './pages/AnalyticsWelcomePage'
import AnnualReportPage from './pages/AnnualReportPage'
import AnnualReportWindow from './pages/AnnualReportWindow'
import DualReportPage from './pages/DualReportPage'
import DualReportWindow from './pages/DualReportWindow'
import AgreementPage from './pages/AgreementPage'
import GroupAnalyticsPage from './pages/GroupAnalyticsPage'
import SettingsPage from './pages/SettingsPage'
import ExportPage from './pages/ExportPage'
import VideoWindow from './pages/VideoWindow'
import ImageWindow from './pages/ImageWindow'
import SnsPage from './pages/SnsPage'
import ContactsPage from './pages/ContactsPage'
import ChatHistoryPage from './pages/ChatHistoryPage'
import NotificationWindow from './pages/NotificationWindow'

import { useAppStore } from './stores/appStore'
import { themes, useThemeStore, type ThemeId, type ThemeMode } from './stores/themeStore'
import * as configService from './services/config'
import { Download, X, Shield } from 'lucide-react'
import './App.scss'

import UpdateDialog from './components/UpdateDialog'
import UpdateProgressCapsule from './components/UpdateProgressCapsule'
import LockScreen from './components/LockScreen'
import { GlobalSessionMonitor } from './components/GlobalSessionMonitor'
import { BatchTranscribeGlobal } from './components/BatchTranscribeGlobal'
import { BatchImageDecryptGlobal } from './components/BatchImageDecryptGlobal'

function App() {
  const navigate = useNavigate()
  const location = useLocation()

  const {
    setDbConnected,
    updateInfo,
    setUpdateInfo,
    isDownloading,
    setIsDownloading,
    downloadProgress,
    setDownloadProgress,
    showUpdateDialog,
    setShowUpdateDialog,
    setUpdateError,
    isLocked,
    setLocked
  } = useAppStore()

  const { currentTheme, themeMode, setTheme, setThemeMode } = useThemeStore()
  const isAgreementWindow = location.pathname === '/agreement-window'
  const isOnboardingWindow = location.pathname === '/onboarding-window'
  const isVideoPlayerWindow = location.pathname === '/video-player-window'
  const isChatHistoryWindow = location.pathname.startsWith('/chat-history/')
  const isStandaloneChatWindow = location.pathname === '/chat-window'
  const isNotificationWindow = location.pathname === '/notification-window'
  const isExportRoute = location.pathname === '/export'
  const [themeHydrated, setThemeHydrated] = useState(false)

  // 锁定状态
  // const [isLocked, setIsLocked] = useState(false) // Moved to store
  const [lockAvatar, setLockAvatar] = useState<string | undefined>(
    localStorage.getItem('app_lock_avatar') || undefined
  )
  const [lockUseHello, setLockUseHello] = useState(false)

  // 协议同意状态
  const [showAgreement, setShowAgreement] = useState(false)
  const [agreementChecked, setAgreementChecked] = useState(false)
  const [agreementLoading, setAgreementLoading] = useState(true)

  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const appRoot = document.getElementById('app')

    if (isOnboardingWindow || isNotificationWindow) {
      root.style.background = 'transparent'
      body.style.background = 'transparent'
      body.style.overflow = 'hidden'
      if (appRoot) {
        appRoot.style.background = 'transparent'
        appRoot.style.overflow = 'hidden'
      }
    } else {
      root.style.background = 'var(--bg-primary)'
      body.style.background = 'var(--bg-primary)'
      body.style.overflow = ''
      if (appRoot) {
        appRoot.style.background = ''
        appRoot.style.overflow = ''
      }
    }
  }, [isOnboardingWindow])

  // 应用主题
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const applyMode = (mode: ThemeMode, systemDark?: boolean) => {
      const effectiveMode = mode === 'system' ? (systemDark ?? mq.matches ? 'dark' : 'light') : mode
      document.documentElement.setAttribute('data-theme', currentTheme)
      document.documentElement.setAttribute('data-mode', effectiveMode)
      const symbolColor = effectiveMode === 'dark' ? '#ffffff' : '#1a1a1a'
      if (!isOnboardingWindow && !isNotificationWindow) {
        window.electronAPI.window.setTitleBarOverlay({ symbolColor })
      }
    }

    applyMode(themeMode)

    // 监听系统主题变化
    const handler = (e: MediaQueryListEvent) => {
      if (useThemeStore.getState().themeMode === 'system') {
        applyMode('system', e.matches)
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [currentTheme, themeMode, isOnboardingWindow, isNotificationWindow])

  // 读取已保存的主题设置
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const [savedThemeId, savedThemeMode] = await Promise.all([
          configService.getThemeId(),
          configService.getTheme()
        ])
        if (savedThemeId && themes.some((theme) => theme.id === savedThemeId)) {
          setTheme(savedThemeId as ThemeId)
        }
        if (savedThemeMode === 'light' || savedThemeMode === 'dark' || savedThemeMode === 'system') {
          setThemeMode(savedThemeMode)
        }
      } catch (e) {
        console.error('读取主题配置失败:', e)
      } finally {
        setThemeHydrated(true)
      }
    }
    loadTheme()
  }, [setTheme, setThemeMode])

  // 保存主题设置
  useEffect(() => {
    if (!themeHydrated) return
    const saveTheme = async () => {
      try {
        await Promise.all([
          configService.setThemeId(currentTheme),
          configService.setTheme(themeMode)
        ])
      } catch (e) {
        console.error('保存主题配置失败:', e)
      }
    }
    saveTheme()
  }, [currentTheme, themeMode, themeHydrated])

  // 检查是否已同意协议
  useEffect(() => {
    const checkAgreement = async () => {
      try {
        const agreed = await configService.getAgreementAccepted()
        if (!agreed) {
          setShowAgreement(true)
        }
      } catch (e) {
        console.error('检查协议状态失败:', e)
      } finally {
        setAgreementLoading(false)
      }
    }
    checkAgreement()
  }, [])

  const handleAgree = async () => {
    if (!agreementChecked) return
    await configService.setAgreementAccepted(true)
    setShowAgreement(false)
  }

  const handleDisagree = () => {
    window.electronAPI.window.close()
  }

  // 监听启动时的更新通知
  useEffect(() => {
    if (isNotificationWindow) return // Skip updates in notification window

    const removeUpdateListener = window.electronAPI?.app?.onUpdateAvailable?.((info: any) => {
      // 发现新版本时保存更新信息，锁定状态下不弹窗，解锁后再显示
      if (info) {
        setUpdateInfo({ ...info, hasUpdate: true })
        if (!useAppStore.getState().isLocked) {
          setShowUpdateDialog(true)
        }
      }
    })
    const removeProgressListener = window.electronAPI?.app?.onDownloadProgress?.((progress: any) => {
      setDownloadProgress(progress)
    })
    return () => {
      removeUpdateListener?.()
      removeProgressListener?.()
    }
  }, [setUpdateInfo, setDownloadProgress, setShowUpdateDialog, isNotificationWindow])

  // 解锁后显示暂存的更新弹窗
  useEffect(() => {
    if (!isLocked && updateInfo?.hasUpdate && !showUpdateDialog && !isDownloading) {
      setShowUpdateDialog(true)
    }
  }, [isLocked])

  const handleUpdateNow = async () => {
    setShowUpdateDialog(false)
    setIsDownloading(true)
    setDownloadProgress({ percent: 0 })
    try {
      await window.electronAPI.app.downloadAndInstall()
    } catch (e: any) {
      console.error('更新失败:', e)
      setIsDownloading(false)
      // Extract clean error message if possible
      const errorMsg = e.message || String(e)
      setUpdateError(errorMsg.includes('暂时禁用') ? '自动更新已暂时禁用' : errorMsg)
    }
  }

  const handleIgnoreUpdate = async () => {
    if (!updateInfo || !updateInfo.version) return

    try {
      await window.electronAPI.app.ignoreUpdate(updateInfo.version)
      setShowUpdateDialog(false)
      setUpdateInfo(null)
    } catch (e: any) {
      console.error('忽略更新失败:', e)
    }
  }

  const dismissUpdate = () => {
    setUpdateInfo(null)
  }

  // 启动时自动检查配置并连接数据库
  useEffect(() => {
    if (isAgreementWindow || isOnboardingWindow) return

    const autoConnect = async () => {
      try {
        const dbPath = await configService.getDbPath()
        const decryptKey = await configService.getDecryptKey()
        const wxid = await configService.getMyWxid()
        const onboardingDone = await configService.getOnboardingDone()
        const wxidConfig = wxid ? await configService.getWxidConfig(wxid) : null
        const effectiveDecryptKey = wxidConfig?.decryptKey || decryptKey

        if (wxidConfig?.decryptKey && wxidConfig.decryptKey !== decryptKey) {
          await configService.setDecryptKey(wxidConfig.decryptKey)
        }

        // 如果配置完整，自动测试连接
        if (dbPath && effectiveDecryptKey && wxid) {
          if (!onboardingDone) {
            await configService.setOnboardingDone(true)
          }

          const result = await window.electronAPI.chat.connect()

          if (result.success) {

            setDbConnected(true, dbPath)
            // 如果当前在欢迎页，跳转到首页
            if (window.location.hash === '#/' || window.location.hash === '') {
              navigate('/home')
            }
          } else {

            // 如果错误信息包含 VC++ 或 DLL 相关内容，不清除配置，只提示用户
            // 其他错误可能需要重新配置
            const errorMsg = result.error || ''
            if (errorMsg.includes('Visual C++') ||
              errorMsg.includes('DLL') ||
              errorMsg.includes('Worker') ||
              errorMsg.includes('126') ||
              errorMsg.includes('模块')) {
              console.warn('检测到可能的运行时依赖问题:', errorMsg)
              // 不清除配置，让用户安装 VC++ 后重试
            }
          }
        }
      } catch (e) {
        console.error('自动连接出错:', e)
        // 捕获异常但不清除配置，防止循环重新引导
      }
    }

    autoConnect()
  }, [isAgreementWindow, isOnboardingWindow, navigate, setDbConnected])

  // 检查应用锁
  useEffect(() => {
    if (isAgreementWindow || isOnboardingWindow || isVideoPlayerWindow) return

    const checkLock = async () => {
      // 并行获取配置，减少等待
      const [enabled, useHello] = await Promise.all([
        window.electronAPI.auth.verifyEnabled(),
        configService.getAuthUseHello()
      ])

      if (enabled) {
        setLockUseHello(useHello)
        setLocked(true)
        // 尝试获取头像
        try {
          const result = await window.electronAPI.chat.getMyAvatarUrl()
          if (result && result.success && result.avatarUrl) {
            setLockAvatar(result.avatarUrl)
            localStorage.setItem('app_lock_avatar', result.avatarUrl)
          }
        } catch (e) {
          console.error('获取锁屏头像失败', e)
        }
      }
    }
    checkLock()
  }, [isAgreementWindow, isOnboardingWindow, isVideoPlayerWindow])

  // 独立协议窗口
  if (isAgreementWindow) {
    return <AgreementPage />
  }

  if (isOnboardingWindow) {
    return <WelcomePage standalone />
  }

  // 独立视频播放窗口
  if (isVideoPlayerWindow) {
    return <VideoWindow />
  }

  // 独立图片查看窗口
  const isImageViewerWindow = location.pathname === '/image-viewer-window'
  if (isImageViewerWindow) {
    return <ImageWindow />
  }

  // 独立聊天记录窗口
  if (isChatHistoryWindow) {
    return <ChatHistoryPage />
  }

  // 独立会话聊天窗口（仅显示聊天内容区域）
  if (isStandaloneChatWindow) {
    const sessionId = new URLSearchParams(location.search).get('sessionId') || ''
    return <ChatPage standaloneSessionWindow initialSessionId={sessionId} />
  }

  // 独立通知窗口
  if (isNotificationWindow) {
    return <NotificationWindow />
  }

  // 主窗口 - 完整布局
  return (
    <div className="app-container">
      <div className="window-drag-region" aria-hidden="true" />
      {isLocked && (
        <LockScreen
          onUnlock={() => setLocked(false)}
          avatar={lockAvatar}
          useHello={lockUseHello}
        />
      )}
      <TitleBar />

      {/* 全局悬浮进度胶囊 (处理：新版本提示、下载进度、错误提示) */}
      <UpdateProgressCapsule />

      {/* 全局会话监听与通知 */}
      <GlobalSessionMonitor />

      {/* 全局批量转写进度浮窗 */}
      <BatchTranscribeGlobal />
      <BatchImageDecryptGlobal />

      {/* 用户协议弹窗 */}
      {showAgreement && !agreementLoading && (
        <div className="agreement-overlay">
          <div className="agreement-modal">
            <div className="agreement-header">
              <Shield size={32} />
              <h2>用户协议与隐私政策</h2>
            </div>
            <div className="agreement-content">
              <p>欢迎使用WeFlow！在使用本软件前，请仔细阅读以下条款：</p>
              <div className="agreement-notice">
                <strong>这是免费软件，如果你是付费购买的话请骂死那个骗子。</strong>
                <span className="agreement-notice-link">
                  我们唯一的官方网站：
                  <a href="https://github.com/hicccc77/WeFlow" target="_blank" rel="noreferrer">
                    https://github.com/hicccc77/WeFlow
                  </a>
                </span>
              </div>
              <div className="agreement-text">
                <h4>1. 数据安全</h4>
                <p>本软件所有数据处理均在本地完成，不会上传任何聊天记录、个人信息到服务器。你的数据完全由你自己掌控。</p>

                <h4>2. 使用须知</h4>
                <p>本软件仅供个人学习研究使用，请勿用于任何非法用途。使用本软件解密、查看、分析的数据应为你本人所有或已获得授权。</p>

                <h4>3. 免责声明</h4>
                <p>因使用本软件产生的任何直接或间接损失，开发者不承担任何责任。请确保你的使用行为符合当地法律法规。</p>

                <h4>4. 隐私保护</h4>
                <p>本软件不收集任何用户数据。软件更新检测仅获取版本信息，不涉及任何个人隐私。</p>
              </div>
            </div>
            <div className="agreement-footer">
              <label className="agreement-checkbox">
                <input
                  type="checkbox"
                  checked={agreementChecked}
                  onChange={(e) => setAgreementChecked(e.target.checked)}
                />
                <span>我已阅读并同意上述协议</span>
              </label>
              <div className="agreement-actions">
                <button className="btn btn-secondary" onClick={handleDisagree}>不同意</button>
                <button className="btn btn-primary" onClick={handleAgree} disabled={!agreementChecked}>同意并继续</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 更新提示对话框 */}
      <UpdateDialog
        open={showUpdateDialog}
        updateInfo={updateInfo}
        onClose={() => setShowUpdateDialog(false)}
        onUpdate={handleUpdateNow}
        onIgnore={handleIgnoreUpdate}
        isDownloading={isDownloading}
        progress={downloadProgress}
      />

      <div className="main-layout">
        <Sidebar />
        <main className="content">
          <RouteGuard>
            <div className={`export-keepalive-page ${isExportRoute ? 'active' : 'hidden'}`} aria-hidden={!isExportRoute}>
              <ExportPage />
            </div>

            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/chat" element={<ChatPage />} />

              <Route path="/analytics" element={<AnalyticsWelcomePage />} />
              <Route path="/analytics/view" element={<AnalyticsPage />} />
              <Route path="/group-analytics" element={<GroupAnalyticsPage />} />
              <Route path="/annual-report" element={<AnnualReportPage />} />
              <Route path="/annual-report/view" element={<AnnualReportWindow />} />
              <Route path="/dual-report" element={<DualReportPage />} />
              <Route path="/dual-report/view" element={<DualReportWindow />} />

              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/export" element={<div className="export-route-anchor" aria-hidden="true" />} />
              <Route path="/sns" element={<SnsPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/chat-history/:sessionId/:messageId" element={<ChatHistoryPage />} />
            </Routes>
          </RouteGuard>
        </main>
      </div>
    </div>
  )
}

export default App
