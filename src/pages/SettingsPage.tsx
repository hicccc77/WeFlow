import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { useThemeStore, themes } from '../stores/themeStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import { 
  Eye, EyeOff, FolderSearch, FolderOpen, Search, Copy,
  RotateCcw, Trash2, Save, Plug, Check, Sun, Moon,
  Palette, Database, Download, HardDrive, Info, RefreshCw
} from 'lucide-react'
import './SettingsPage.scss'

type SettingsTab = 'appearance' | 'database' | 'export' | 'cache' | 'about'

const tabs: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'database', label: '数据库连接', icon: Database },
  { id: 'export', label: '导出', icon: Download },
  { id: 'cache', label: '缓存', icon: HardDrive },
  { id: 'about', label: '关于', icon: Info }
]

function SettingsPage() {
  const { setDbConnected, setLoading } = useAppStore()
  const { currentTheme, themeMode, setTheme, setThemeMode } = useThemeStore()

  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [decryptKey, setDecryptKey] = useState('')
  const [dbPath, setDbPath] = useState('')
  const [wxid, setWxid] = useState('')
  const [cachePath, setCachePath] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [defaultExportPath, setDefaultExportPath] = useState('')
  const [logEnabled, setLogEnabled] = useState(false)
  
  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [appVersion, setAppVersion] = useState('')
  const [updateInfo, setUpdateInfo] = useState<{ hasUpdate: boolean; version?: string; releaseNotes?: string } | null>(null)
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [showDecryptKey, setShowDecryptKey] = useState(false)

  useEffect(() => {
    loadConfig()
    loadDefaultExportPath()
    loadAppVersion()
  }, [])

  const loadConfig = async () => {
    try {
      const savedKey = await configService.getDecryptKey()
      const savedPath = await configService.getDbPath()
      const savedWxid = await configService.getMyWxid()
      const savedCachePath = await configService.getCachePath()
      const savedExportPath = await configService.getExportPath()
      const savedLogEnabled = await configService.getLogEnabled()
      
      if (savedKey) setDecryptKey(savedKey)
      if (savedPath) setDbPath(savedPath)
      if (savedWxid) setWxid(savedWxid)
      if (savedCachePath) setCachePath(savedCachePath)
      if (savedExportPath) setExportPath(savedExportPath)
      setLogEnabled(savedLogEnabled)
    } catch (e) {
      console.error('加载配置失败:', e)
    }
  }

  const loadDefaultExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setDefaultExportPath(downloadsPath)
    } catch (e) {
      console.error('获取默认导出路径失败:', e)
    }
  }

  const loadAppVersion = async () => {
    try {
      const version = await window.electronAPI.app.getVersion()
      setAppVersion(version)
    } catch (e) {
      console.error('获取版本号失败:', e)
    }
  }

  // 监听下载进度
  useEffect(() => {
    const removeListener = window.electronAPI.app.onDownloadProgress?.((progress: number) => {
      setDownloadProgress(progress)
    })
    return () => removeListener?.()
  }, [])

  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true)
    setUpdateInfo(null)
    try {
      const result = await window.electronAPI.app.checkForUpdates()
      if (result.hasUpdate) {
        setUpdateInfo(result)
        showMessage(`发现新版本 ${result.version}`, true)
      } else {
        showMessage('当前已是最新版本', true)
      }
    } catch (e) {
      showMessage(`检查更新失败: ${e}`, false)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  const handleUpdateNow = async () => {
    setIsDownloading(true)
    setDownloadProgress(0)
    try {
      showMessage('正在下载更新...', true)
      await window.electronAPI.app.downloadAndInstall()
    } catch (e) {
      showMessage(`更新失败: ${e}`, false)
      setIsDownloading(false)
    }
  }

  const showMessage = (text: string, success: boolean) => {
    setMessage({ text, success })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleAutoDetectPath = async () => {
    if (isDetectingPath) return
    setIsDetectingPath(true)
    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        setDbPath(result.path)
        await configService.setDbPath(result.path)
        showMessage(`自动检测成功：${result.path}`, true)
        
        const wxids = await window.electronAPI.dbPath.scanWxids(result.path)
        if (wxids.length === 1) {
          setWxid(wxids[0])
          await configService.setMyWxid(wxids[0])
          showMessage(`已检测到账号：${wxids[0]}`, true)
        } else if (wxids.length > 1) {
          showMessage(`检测到 ${wxids.length} 个账号，请手动选择`, true)
        }
      } else {
        showMessage(result.error || '未能自动检测到数据库目录', false)
      }
    } catch (e) {
      showMessage(`自动检测失败: ${e}`, false)
    } finally {
      setIsDetectingPath(false)
    }
  }

  const handleSelectDbPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择微信数据库根目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        showMessage('已选择数据库目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleScanWxid = async () => {
    if (!dbPath) {
      showMessage('请先选择数据库目录', false)
      return
    }
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      if (wxids.length === 1) {
        setWxid(wxids[0])
        await configService.setMyWxid(wxids[0])
        showMessage(`已检测到账号：${wxids[0]}`, true)
      } else if (wxids.length > 1) {
        showMessage(`检测到 ${wxids.length} 个账号，请手动选择`, true)
      } else {
        showMessage('未检测到账号目录，请检查路径', false)
      }
    } catch (e) {
      showMessage(`扫描失败: ${e}`, false)
    }
  }

  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择缓存目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        showMessage('已选择缓存目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleSelectExportPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择导出目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setExportPath(result.filePaths[0])
        await configService.setExportPath(result.filePaths[0])
        showMessage('已设置导出目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleResetExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setExportPath(downloadsPath)
      await configService.setExportPath(downloadsPath)
      showMessage('已恢复为下载目录', true)
    } catch (e) {
      showMessage('恢复默认失败', false)
    }
  }

  const handleTestConnection = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey) { showMessage('请先输入解密密钥', false); return }
    if (decryptKey.length !== 64) { showMessage('密钥长度必须为64个字符', false); return }
    if (!wxid) { showMessage('请先输入或扫描 wxid', false); return }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        showMessage('连接测试成功！数据库可正常访问', true)
      } else {
        showMessage(result.error || '连接测试失败', false)
      }
    } catch (e) {
      showMessage(`连接测试失败: ${e}`, false)
    } finally {
      setIsTesting(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!decryptKey) { showMessage('请输入解密密钥', false); return }
    if (decryptKey.length !== 64) { showMessage('密钥长度必须为64个字符', false); return }
    if (!dbPath) { showMessage('请选择数据库目录', false); return }
    if (!wxid) { showMessage('请输入 wxid', false); return }

    setIsLoadingState(true)
    setLoading(true, '正在保存配置...')

    try {
      await configService.setDecryptKey(decryptKey)
      await configService.setDbPath(dbPath)
      await configService.setMyWxid(wxid)
      await configService.setCachePath(cachePath)

      showMessage('配置保存成功，正在测试连接...', true)
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)

      if (result.success) {
        setDbConnected(true, dbPath)
        showMessage('配置保存成功！数据库连接正常', true)
      } else {
        showMessage(result.error || '数据库连接失败，请检查配置', false)
      }
    } catch (e) {
      showMessage(`保存配置失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  const handleOpenLog = async () => {
    try {
      const logPath = await window.electronAPI.log.getPath()
      await window.electronAPI.shell.openPath(logPath)
    } catch (e) {
      showMessage(`打开日志失败: ${e}`, false)
    }
  }

  const handleCopyLog = async () => {
    try {
      const result = await window.electronAPI.log.read()
      if (!result.success) {
        showMessage(result.error || '读取日志失败', false)
        return
      }
      await navigator.clipboard.writeText(result.content || '')
      showMessage('日志已复制到剪贴板', true)
    } catch (e) {
      showMessage(`复制日志失败: ${e}`, false)
    }
  }

  const renderAppearanceTab = () => (
    <div className="tab-content">
      <div className="theme-mode-toggle">
        <button className={`mode-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => setThemeMode('light')}>
          <Sun size={16} /> 浅色
        </button>
        <button className={`mode-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => setThemeMode('dark')}>
          <Moon size={16} /> 深色
        </button>
      </div>
      <div className="theme-grid">
        {themes.map((theme) => (
          <div key={theme.id} className={`theme-card ${currentTheme === theme.id ? 'active' : ''}`} onClick={() => setTheme(theme.id)}>
            <div className="theme-preview" style={{ background: themeMode === 'dark' ? 'linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%)' : `linear-gradient(135deg, ${theme.bgColor} 0%, ${theme.bgColor}dd 100%)` }}>
              <div className="theme-accent" style={{ background: theme.primaryColor }} />
            </div>
            <div className="theme-info">
              <span className="theme-name">{theme.name}</span>
              <span className="theme-desc">{theme.description}</span>
            </div>
            {currentTheme === theme.id && <div className="theme-check"><Check size={14} /></div>}
          </div>
        ))}
      </div>
    </div>
  )

  const renderDatabaseTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>解密密钥</label>
        <span className="form-hint">64位十六进制密钥</span>
        <div className="input-with-toggle">
          <input type={showDecryptKey ? 'text' : 'password'} placeholder="例如: a1b2c3d4e5f6..." value={decryptKey} onChange={(e) => setDecryptKey(e.target.value)} />
          <button type="button" className="toggle-visibility" onClick={() => setShowDecryptKey(!showDecryptKey)}>
            {showDecryptKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>数据库根目录</label>
        <span className="form-hint">xwechat_files 目录</span>
        <input type="text" placeholder="例如: C:\Users\xxx\Documents\xwechat_files" value={dbPath} onChange={(e) => setDbPath(e.target.value)} />
        <div className="btn-row">
          <button className="btn btn-primary" onClick={handleAutoDetectPath} disabled={isDetectingPath}>
            <FolderSearch size={16} /> {isDetectingPath ? '检测中...' : '自动检测'}
          </button>
          <button className="btn btn-secondary" onClick={handleSelectDbPath}><FolderOpen size={16} /> 浏览选择</button>
        </div>
      </div>

      <div className="form-group">
        <label>账号 wxid</label>
        <span className="form-hint">微信账号标识</span>
        <input type="text" placeholder="例如: wxid_xxxxxx" value={wxid} onChange={(e) => setWxid(e.target.value)} />
        <button className="btn btn-secondary btn-sm" onClick={handleScanWxid}><Search size={14} /> 扫描 wxid</button>
      </div>

      <div className="form-group">
        <label>缓存目录 <span className="optional">(可选)</span></label>
        <span className="form-hint">留空使用默认目录</span>
        <input type="text" placeholder="留空使用默认目录" value={cachePath} onChange={(e) => setCachePath(e.target.value)} />
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={handleSelectCachePath}><FolderOpen size={16} /> 浏览选择</button>
          <button className="btn btn-secondary" onClick={() => setCachePath('')}><RotateCcw size={16} /> 恢复默认</button>
        </div>
      </div>

      <div className="form-group">
        <label>调试日志</label>
        <span className="form-hint">开启后写入 WCDB 调试日志，便于排查连接问题</span>
        <div className="log-toggle-line">
          <span className="log-status">{logEnabled ? '已开启' : '已关闭'}</span>
          <label className="switch" htmlFor="log-enabled-toggle">
            <input
              id="log-enabled-toggle"
              className="switch-input"
              type="checkbox"
              checked={logEnabled}
              onChange={async (e) => {
                const enabled = e.target.checked
                setLogEnabled(enabled)
                await configService.setLogEnabled(enabled)
                showMessage(enabled ? '已开启日志' : '已关闭日志', true)
              }}
            />
            <span className="switch-slider" />
          </label>
        </div>
        <div className="log-actions">
          <button className="btn btn-secondary" onClick={handleOpenLog}>
            <FolderOpen size={16} /> 打开日志文件
          </button>
          <button className="btn btn-secondary" onClick={handleCopyLog}>
            <Copy size={16} /> 复制日志内容
          </button>
        </div>
      </div>
    </div>
  )

  const renderExportTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>导出目录</label>
        <span className="form-hint">聊天记录导出的默认保存位置</span>
        <input type="text" placeholder={defaultExportPath || '系统下载目录'} value={exportPath || defaultExportPath} onChange={(e) => setExportPath(e.target.value)} />
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={handleSelectExportPath}><FolderOpen size={16} /> 浏览选择</button>
          <button className="btn btn-secondary" onClick={handleResetExportPath}><RotateCcw size={16} /> 恢复默认</button>
        </div>
      </div>
    </div>
  )

  const renderCacheTab = () => (
    <div className="tab-content">
      <p className="section-desc">管理应用缓存数据</p>
      <div className="btn-row">
        <button className="btn btn-secondary"><Trash2 size={16} /> 清除分析缓存</button>
        <button className="btn btn-secondary"><Trash2 size={16} /> 清除图片缓存</button>
        <button className="btn btn-danger"><Trash2 size={16} /> 清除所有缓存</button>
      </div>
    </div>
  )

  const renderAboutTab = () => (
    <div className="tab-content about-tab">
      <div className="about-card">
        <div className="about-logo">
          <img src="./logo.png" alt="WeFlow" />
        </div>
        <h2 className="about-name">WeFlow</h2>
        <p className="about-slogan">WeFlow</p>
        <p className="about-version">v{appVersion || '...'}</p>
        
        <div className="about-update">
          {updateInfo?.hasUpdate ? (
            <>
              <p className="update-hint">新版本 v{updateInfo.version} 可用</p>
              {isDownloading ? (
                <div className="download-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${downloadProgress}%` }} />
                  </div>
                  <span>{downloadProgress.toFixed(0)}%</span>
                </div>
              ) : (
                <button className="btn btn-primary" onClick={handleUpdateNow}>
                  <Download size={16} /> 立即更新
                </button>
              )}
            </>
          ) : (
            <button className="btn btn-secondary" onClick={handleCheckUpdate} disabled={isCheckingUpdate}>
              <RefreshCw size={16} className={isCheckingUpdate ? 'spin' : ''} />
              {isCheckingUpdate ? '检查中...' : '检查更新'}
            </button>
          )}
        </div>
      </div>

      <div className="about-footer">
        <p className="about-desc">微信聊天记录分析工具</p>
        <div className="about-links">
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.shell.openExternal('https://chatlab.fun') }}>ChatLab</a>
          <span>·</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.window.openAgreementWindow() }}>用户协议</a>
        </div>
        <p className="copyright">© 2025 WeFlow. All rights reserved.</p>
      </div>
    </div>
  )

  return (
    <div className="settings-page">
      {message && <div className={`message-toast ${message.success ? 'success' : 'error'}`}>{message.text}</div>}

      <div className="settings-header">
        <h1>设置</h1>
        <div className="settings-actions">
          <button className="btn btn-secondary" onClick={handleTestConnection} disabled={isLoading || isTesting}>
            <Plug size={16} /> {isTesting ? '测试中...' : '测试连接'}
          </button>
          <button className="btn btn-primary" onClick={handleSaveConfig} disabled={isLoading}>
            <Save size={16} /> {isLoading ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>

      <div className="settings-tabs">
        {tabs.map(tab => (
          <button key={tab.id} className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
            <tab.icon size={16} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="settings-body">
        {activeTab === 'appearance' && renderAppearanceTab()}
        {activeTab === 'database' && renderDatabaseTab()}
        {activeTab === 'export' && renderExportTab()}
        {activeTab === 'cache' && renderCacheTab()}
        {activeTab === 'about' && renderAboutTab()}
      </div>
    </div>
  )
}

export default SettingsPage
