import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  ArrowLeft, ArrowRight, CheckCircle2, Database, Eye, EyeOff,
  FolderOpen, FolderSearch, KeyRound, ShieldCheck, Sparkles,
  UserRound, Wand2, Minus, X, HardDrive, RotateCcw
} from 'lucide-react'
import './WelcomePage.scss'

const steps = [
  { id: 'intro', title: '欢迎', desc: '准备开始你的本地数据探索' },
  { id: 'db', title: '数据库目录', desc: '定位 xwechat_files 目录' },
  { id: 'cache', title: '缓存目录', desc: '设置本地缓存存储位置（可选）' },
  { id: 'key', title: '解密密钥', desc: '获取密钥与自动识别账号' },
  { id: 'image', title: '图片密钥', desc: '获取 XOR 与 AES 密钥' }
]

interface WelcomePageProps {
  standalone?: boolean
}

function WelcomePage({ standalone = false }: WelcomePageProps) {
  const navigate = useNavigate()
  const { isDbConnected, setDbConnected, setLoading } = useAppStore()

  const [stepIndex, setStepIndex] = useState(0)
  const [dbPath, setDbPath] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [cachePath, setCachePath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<Array<{ wxid: string; modifiedTime: number }>>([])
  const [error, setError] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [isManualStartPrompt, setIsManualStartPrompt] = useState(false)

  useEffect(() => {
    const removeDb = window.electronAPI.key.onDbKeyStatus((payload) => {
      setDbKeyStatus(payload.message)
    })
    const removeImage = window.electronAPI.key.onImageKeyStatus((payload) => {
      setImageKeyStatus(payload.message)
    })
    return () => {
      removeDb?.()
      removeImage?.()
    }
  }, [])

  useEffect(() => {
    if (isDbConnected && !standalone) {
      navigate('/home')
    }
  }, [isDbConnected, standalone, navigate])

  useEffect(() => {
    setWxidOptions([])
    setWxid('')
  }, [dbPath])

  const currentStep = steps[stepIndex]
  const rootClassName = `welcome-page${isClosing ? ' is-closing' : ''}${standalone ? ' is-standalone' : ''}`
  const showWindowControls = standalone

  const handleMinimize = () => {
    window.electronAPI.window.minimize()
  }

  const handleCloseWindow = () => {
    window.electronAPI.window.close()
  }

  const handleSelectPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信数据库目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择目录失败')
    }
  }

  const handleAutoDetectPath = async () => {
    if (isDetectingPath) return
    setIsDetectingPath(true)
    setError('')
    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        setDbPath(result.path)
        setError('')
      } else {
        setError(result.error || '未能检测到数据库目录')
      }
    } catch (e) {
      setError(`自动检测失败: ${e}`)
    } finally {
      setIsDetectingPath(false)
    }
  }

  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择缓存目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择缓存目录失败')
    }
  }

  const handleScanWxid = async (silent = false) => {
    if (!dbPath) {
      if (!silent) setError('请先选择数据库目录')
      return
    }
    if (isScanningWxid) return
    setIsScanningWxid(true)
    if (!silent) setError('')
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setWxidOptions(wxids)
      if (wxids.length > 0) {
        // scanWxids 已经按时间排过序了，直接取第一个
        setWxid(wxids[0].wxid)
        if (!silent) setError('')
      } else {
        if (!silent) setError('未检测到账号目录，请检查路径')
      }
    } catch (e) {
      if (!silent) setError(`扫描失败: ${e}`)
    } finally {
      setIsScanningWxid(false)
    }
  }

  const handleAutoGetDbKey = async () => {
    if (isFetchingDbKey) return
    setIsFetchingDbKey(true)
    setError('')
    setIsManualStartPrompt(false)
    setDbKeyStatus('正在连接微信进程...')
    try {
      const result = await window.electronAPI.key.autoGetDbKey()
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setDbKeyStatus('密钥获取成功')
        setError('')
        // 获取成功后自动扫描并填入 wxid
        await handleScanWxid(true)
      } else {
        if (result.error?.includes('未找到微信安装路径') || result.error?.includes('启动微信失败')) {
          setIsManualStartPrompt(true)
          setDbKeyStatus('需要手动启动微信')
        } else {
          setError(result.error || '自动获取密钥失败')
        }
      }
    } catch (e) {
      setError(`自动获取密钥失败: ${e}`)
    } finally {
      setIsFetchingDbKey(false)
    }
  }

  const handleManualConfirm = async () => {
    setIsManualStartPrompt(false)
    handleAutoGetDbKey()
  }

  const handleAutoGetImageKey = async () => {
    if (isFetchingImageKey) return
    if (!dbPath) {
      setError('请先选择数据库目录')
      return
    }
    setIsFetchingImageKey(true)
    setError('')
    setImageKeyStatus('正在准备获取图片密钥...')
    try {
      // 拼接完整的账号目录，确保 KeyService 能准确找到模板文件
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.key.autoGetImageKey(accountPath)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') {
          setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        }
        setImageAesKey(result.aesKey)
        setImageKeyStatus('已获取图片密钥')
      } else {
        setError(result.error || '自动获取图片密钥失败')
      }
    } catch (e) {
      setError(`自动获取图片密钥失败: ${e}`)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const canGoNext = () => {
    if (currentStep.id === 'intro') return true
    if (currentStep.id === 'db') return Boolean(dbPath)
    if (currentStep.id === 'cache') return true
    if (currentStep.id === 'key') return decryptKey.length === 64 && Boolean(wxid)
    if (currentStep.id === 'image') return true
    return false
  }

  const handleNext = () => {
    if (!canGoNext()) {
      if (currentStep.id === 'db' && !dbPath) setError('请先选择数据库目录')
      if (currentStep.id === 'key') {
        if (decryptKey.length !== 64) setError('密钥长度必须为 64 个字符')
        else if (!wxid) setError('未能自动识别 wxid，请尝试重新获取或检查目录')
      }
      return
    }
    setError('')
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1))
  }

  const handleBack = () => {
    setError('')
    setStepIndex((prev) => Math.max(prev - 1, 0))
  }

  const handleConnect = async () => {
    if (!dbPath) { setError('请先选择数据库目录'); return }
    if (!wxid) { setError('请填写微信ID'); return }
    if (!decryptKey || decryptKey.length !== 64) { setError('请填写 64 位解密密钥'); return }

    setIsConnecting(true)
    setError('')
    setLoading(true, '正在连接数据库...')

    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (!result.success) {
        setError(result.error || 'WCDB 连接失败')
        setLoading(false)
        return
      }

      await configService.setDbPath(dbPath)
      await configService.setDecryptKey(decryptKey)
      await configService.setMyWxid(wxid)
      await configService.setCachePath(cachePath)
      const parsedXorKey = imageXorKey ? parseInt(imageXorKey.replace(/^0x/i, ''), 16) : null
      await configService.setImageXorKey(typeof parsedXorKey === 'number' && !Number.isNaN(parsedXorKey) ? parsedXorKey : 0)
      await configService.setImageAesKey(imageAesKey || '')
      await configService.setWxidConfig(wxid, {
        decryptKey,
        imageXorKey: typeof parsedXorKey === 'number' && !Number.isNaN(parsedXorKey) ? parsedXorKey : 0,
        imageAesKey
      })
      await configService.setOnboardingDone(true)

      setDbConnected(true, dbPath)
      setLoading(false)

      if (standalone) {
        setIsClosing(true)
        setTimeout(() => {
          window.electronAPI.window.completeOnboarding()
        }, 450)
      } else {
        navigate('/home')
      }
    } catch (e) {
      setError(`连接失败: ${e}`)
      setLoading(false)
    } finally {
      setIsConnecting(false)
    }
  }

  const formatModifiedTime = (time: number) => {
    if (!time) return '未知时间'
    const date = new Date(time)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}`
  }

  if (isDbConnected) {
    return (
      <div className={rootClassName}>
        <div className="welcome-container">
          {showWindowControls && (
            <div className="window-controls">
              <button type="button" className="window-btn" onClick={handleMinimize} aria-label="最小化">
                <Minus size={14} />
              </button>
              <button type="button" className="window-btn is-close" onClick={handleCloseWindow} aria-label="关闭">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="welcome-sidebar">
            <div className="sidebar-header">
              <img src="./logo.png" alt="WeFlow" className="sidebar-logo" />
              <div className="sidebar-brand">
                <span className="brand-name">WeFlow</span>
                <span className="brand-tag">Connected</span>
              </div>
            </div>

            <div className="sidebar-spacer" style={{ flex: 1 }} />

            <div className="sidebar-footer">
              <ShieldCheck size={14} />
              <span>本地安全存储</span>
            </div>
          </div>

          <div className="welcome-content success-content">
            <div className="success-body">
              <div className="success-icon">
                <CheckCircle2 size={48} />
              </div>
              <h1 className="success-title">配置已完成</h1>
              <p className="success-desc">数据库已连接，你可以直接进入首页使用全部功能。</p>

              <button
                className="btn btn-primary btn-large"
                onClick={() => {
                  if (standalone) {
                    setIsClosing(true)
                    setTimeout(() => {
                      window.electronAPI.window.completeOnboarding()
                    }, 450)
                  } else {
                    navigate('/home')
                  }
                }}
              >
                进入首页 <ArrowRight size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={rootClassName}>
      <div className="welcome-container">
        {showWindowControls && (
          <div className="window-controls">
            <button type="button" className="window-btn" onClick={handleMinimize} aria-label="最小化">
              <Minus size={14} />
            </button>
            <button type="button" className="window-btn is-close" onClick={handleCloseWindow} aria-label="关闭">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="welcome-sidebar">
          <div className="sidebar-header">
            <img src="./logo.png" alt="WeFlow" className="sidebar-logo" />
            <div className="sidebar-brand">
              <span className="brand-name">WeFlow</span>
              <span className="brand-tag">Setup</span>
            </div>
          </div>

          <div className="sidebar-nav">
            {steps.map((step, index) => (
              <div key={step.id} className={`nav-item ${index === stepIndex ? 'active' : ''} ${index < stepIndex ? 'completed' : ''}`}>
                <div className="nav-indicator">
                  {index < stepIndex ? <CheckCircle2 size={14} /> : <div className="dot" />}
                </div>
                <div className="nav-info">
                  <div className="nav-title">{step.title}</div>
                  <div className="nav-desc">{step.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="sidebar-footer">
            <ShieldCheck size={14} />
            <span>数据仅在本地处理，不上传服务器</span>
          </div>
        </div>

        <div className="welcome-content">
          <div className="content-header">
            <div>
              <h2>{currentStep.title}</h2>
              <p className="header-desc">{currentStep.desc}</p>
            </div>
          </div>

          <div className="content-body">
            {currentStep.id === 'intro' && (
              <div className="intro-block">
                {/* 内容移至底部 */}
              </div>
            )}

            {currentStep.id === 'db' && (
              <div className="form-group">
                <label className="field-label">数据库根目录</label>
                <div className="input-group">
                  <input
                    type="text"
                    className="field-input"
                    placeholder="例如：C:\\Users\\xxx\\Documents\\xwechat_files"
                    value={dbPath}
                    onChange={(e) => setDbPath(e.target.value)}
                  />
                </div>
                <div className="action-row">
                  <button className="btn btn-secondary" onClick={handleAutoDetectPath} disabled={isDetectingPath}>
                    <FolderSearch size={16} /> {isDetectingPath ? '检测中...' : '自动检测'}
                  </button>
                  <button className="btn btn-secondary" onClick={handleSelectPath}>
                    <FolderOpen size={16} /> 浏览...
                  </button>
                </div>

                <div className="field-hint">请选择微信-设置-存储位置对应的目录</div>
                <div className="field-hint warning">
                  ⚠️ 目录路径不可包含中文，如有中文请先在微信中迁移至全英文目录
                </div>
              </div>
            )}

            {currentStep.id === 'cache' && (
              <div className="form-group">
                <label className="field-label">缓存目录</label>
                <div className="input-group">
                  <input
                    type="text"
                    className="field-input"
                    placeholder="留空即使用默认目录"
                    value={cachePath}
                    onChange={(e) => setCachePath(e.target.value)}
                  />
                </div>
                <div className="action-row">
                  <button className="btn btn-secondary" onClick={handleSelectCachePath}>
                    <FolderOpen size={16} /> 浏览
                  </button>
                  <button className="btn btn-secondary" onClick={() => setCachePath('')}>
                    <RotateCcw size={16} /> 重置默认
                  </button>
                </div>
                <div className="field-hint">用于头像、表情与图片缓存</div>
              </div>
            )}

            {currentStep.id === 'key' && (
              <div className="form-group">
                <label className="field-label">微信账号 (Wxid)</label>
                <input
                  type="text"
                  className="field-input"
                  placeholder="等待获取..."
                  value={wxid}
                  readOnly
                  onChange={(e) => setWxid(e.target.value)}
                />

                <label className="field-label mt-4">解密密钥</label>
                <div className="field-with-toggle">
                  <input
                    type={showDecryptKey ? 'text' : 'password'}
                    className="field-input"
                    placeholder="64 位十六进制密钥"
                    value={decryptKey}
                    onChange={(e) => setDecryptKey(e.target.value.trim())}
                  />
                  <button type="button" className="toggle-btn" onClick={() => setShowDecryptKey(!showDecryptKey)}>
                    {showDecryptKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                <div className="key-actions">
                  {isManualStartPrompt ? (
                    <div className="manual-prompt">
                      <p>未能自动启动微信，请手动启动并登录</p>
                      <button className="btn btn-primary" onClick={handleManualConfirm}>
                        我已登录，继续
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn-secondary btn-block" onClick={handleAutoGetDbKey} disabled={isFetchingDbKey}>
                      {isFetchingDbKey ? '正在获取...' : '自动获取密钥'}
                    </button>
                  )}
                </div>

                {dbKeyStatus && <div className="status-message">{dbKeyStatus}</div>}
                <div className="field-hint">点击自动获取后微信将重启，请留意弹窗提示</div>
              </div>
            )}

            {currentStep.id === 'image' && (
              <div className="form-group">
                <div className="grid-2">
                  <div>
                    <label className="field-label">图片 XOR 密钥</label>
                    <input
                      type="text"
                      className="field-input"
                      placeholder="0x..."
                      value={imageXorKey}
                      onChange={(e) => setImageXorKey(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="field-label">图片 AES 密钥</label>
                    <input
                      type="text"
                      className="field-input"
                      placeholder="16位密钥"
                      value={imageAesKey}
                      onChange={(e) => setImageAesKey(e.target.value)}
                    />
                  </div>
                </div>

                <button className="btn btn-secondary btn-block mt-4" onClick={handleAutoGetImageKey} disabled={isFetchingImageKey}>
                  {isFetchingImageKey ? '扫描中...' : '自动获取图片密钥'}
                </button>

                {imageKeyStatus && <div className="status-message">{imageKeyStatus}</div>}
                <div className="field-hint">请在微信中打开几张图片后再点击获取</div>
              </div>
            )}
          </div>

          {error && <div className="error-message">{error}</div>}

          {currentStep.id === 'intro' && (
            <div className="intro-footer">
              <p>接下来的几个步骤将引导您连接本地微信数据库。</p>
              <p>WeFlow 需要访问您的本地数据文件以提供分析与导出功能。</p>
            </div>
          )}

          <div className="content-actions">
            <button className="btn btn-ghost" onClick={handleBack} disabled={stepIndex === 0}>
              <ArrowLeft size={16} /> 上一步
            </button>

            {stepIndex < steps.length - 1 ? (
              <button className="btn btn-primary" onClick={handleNext} disabled={!canGoNext()}>
                下一步 <ArrowRight size={16} />
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleConnect} disabled={isConnecting || !canGoNext()}>
                {isConnecting ? '连接中...' : '完成配置'} <ArrowRight size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default WelcomePage

