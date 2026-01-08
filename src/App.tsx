import { useEffect, useState } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import RouteGuard from './components/RouteGuard'
import WelcomePage from './pages/WelcomePage'
import HomePage from './pages/HomePage'
import ChatPage from './pages/ChatPage'
import AnalyticsPage from './pages/AnalyticsPage'
import AnnualReportPage from './pages/AnnualReportPage'
import AnnualReportWindow from './pages/AnnualReportWindow'
import AgreementPage from './pages/AgreementPage'
import GroupAnalyticsPage from './pages/GroupAnalyticsPage'
import DataManagementPage from './pages/DataManagementPage'
import SettingsPage from './pages/SettingsPage'
import ExportPage from './pages/ExportPage'
import { useAppStore } from './stores/appStore'
import { themes, useThemeStore, type ThemeId } from './stores/themeStore'
import * as configService from './services/config'
import { Download, X, Shield } from 'lucide-react'
import './App.scss'

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setDbConnected } = useAppStore()
  const { currentTheme, themeMode, setTheme, setThemeMode } = useThemeStore()
  const isAgreementWindow = location.pathname === '/agreement-window'
  const isOnboardingWindow = location.pathname === '/onboarding-window'
  const [themeHydrated, setThemeHydrated] = useState(false)

  // 协议同意状态
  const [showAgreement, setShowAgreement] = useState(false)
  const [agreementChecked, setAgreementChecked] = useState(false)
  const [agreementLoading, setAgreementLoading] = useState(true)

  // 更新提示状态
  const [updateInfo, setUpdateInfo] = useState<{ version: string; releaseNotes: string } | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)

  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const appRoot = document.getElementById('app')

    if (isOnboardingWindow) {
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
    document.documentElement.setAttribute('data-theme', currentTheme)
    document.documentElement.setAttribute('data-mode', themeMode)

    // 更新窗口控件颜色以适配主题
    const symbolColor = themeMode === 'dark' ? '#ffffff' : '#1a1a1a'
    if (!isOnboardingWindow) {
      window.electronAPI.window.setTitleBarOverlay({ symbolColor })
    }
  }, [currentTheme, themeMode, isOnboardingWindow])

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
        if (savedThemeMode === 'light' || savedThemeMode === 'dark') {
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
    const removeUpdateListener = window.electronAPI.app.onUpdateAvailable?.((info) => {
      setUpdateInfo(info)
    })
    const removeProgressListener = window.electronAPI.app.onDownloadProgress?.((progress) => {
      setDownloadProgress(progress)
    })
    return () => {
      removeUpdateListener?.()
      removeProgressListener?.()
    }
  }, [])

  const handleUpdateNow = async () => {
    setIsDownloading(true)
    setDownloadProgress(0)
    try {
      await window.electronAPI.app.downloadAndInstall()
    } catch (e) {
      console.error('更新失败:', e)
      setIsDownloading(false)
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

        // 如果配置完整，自动测试连接
        if (dbPath && decryptKey && wxid) {
          if (!onboardingDone) {
            await configService.setOnboardingDone(true)
          }
          console.log('检测到已保存的配置，正在自动连接...')
          const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)

          if (result.success) {
            console.log('自动连接成功')
            setDbConnected(true, dbPath)
            // 如果当前在欢迎页，跳转到首页
            if (window.location.hash === '#/' || window.location.hash === '') {
              navigate('/home')
            }
          } else {
            console.log('自动连接失败:', result.error)
          }
        }
      } catch (e) {
        console.error('自动连接出错:', e)
      }
    }

    autoConnect()
  }, [isAgreementWindow, isOnboardingWindow, navigate, setDbConnected])

  // 独立协议窗口
  if (isAgreementWindow) {
    return <AgreementPage />
  }

  if (isOnboardingWindow) {
    return <WelcomePage standalone />
  }

  // 主窗口 - 完整布局
  return (
    <div className="app-container">
      <TitleBar />

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
              <div className="agreement-text">
                <h4>1. 数据安全</h4>
                <p>本软件所有数据处理均在本地完成，不会上传任何聊天记录、个人信息到服务器。您的数据完全由您自己掌控。</p>

                <h4>2. 使用须知</h4>
                <p>本软件仅供个人学习研究使用，请勿用于任何非法用途。使用本软件解密、查看、分析的数据应为您本人所有或已获得授权。</p>

                <h4>3. 免责声明</h4>
                <p>因使用本软件产生的任何直接或间接损失，开发者不承担任何责任。请确保您的使用行为符合当地法律法规。</p>

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

      {/* 更新提示条 */}
      {updateInfo && (
        <div className="update-banner">
          <span className="update-text">
            发现新版本 <strong>v{updateInfo.version}</strong>
          </span>
          {isDownloading ? (
            <div className="update-progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${downloadProgress}%` }} />
              </div>
              <span>{downloadProgress.toFixed(0)}%</span>
            </div>
          ) : (
            <>
              <button className="update-btn" onClick={handleUpdateNow}>
                <Download size={14} /> 立即更新
              </button>
              <button className="dismiss-btn" onClick={dismissUpdate}>
                <X size={14} />
              </button>
            </>
          )}
        </div>
      )}

      <div className="main-layout">
        <Sidebar />
        <main className="content">
          <RouteGuard>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/group-analytics" element={<GroupAnalyticsPage />} />
              <Route path="/annual-report" element={<AnnualReportPage />} />
              <Route path="/annual-report/view" element={<AnnualReportWindow />} />
              <Route path="/data-management" element={<DataManagementPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/export" element={<ExportPage />} />
            </Routes>
          </RouteGuard>
        </main>
      </div>
    </div>
  )
}

export default App
