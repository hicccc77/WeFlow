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
      if (imageXorKey) {
        const parsed = parseInt(imageXorKey.replace(/^0x/i, ''), 16)
        if (!Number.isNaN(parsed)) {
          await configService.setImageXorKey(parsed)
        }
      }
      if (imageAesKey) {
        await configService.setImageAesKey(imageAesKey)
      }
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
        <div className="welcome-shell">
          <div className="welcome-panel">
            <div className="panel-header">
              <img src="./logo.png" alt="WeFlow" className="panel-logo" />
              <div>
                <p className="panel-kicker">WeFlow</p>
                <h1>已连接数据库</h1>
              </div>
            </div>
            <div className="panel-note">
              <CheckCircle2 size={16} />
              <span>配置已完成，可直接进入首页</span>
            </div>
            <button
              className="btn btn-primary btn-full"
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
              进入首页
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={rootClassName}>
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
      <div className="welcome-shell">
        <div className="welcome-panel">
          <div className="panel-header">
            <img src="./logo.png" alt="WeFlow" className="panel-logo" />
            <div>
              <p className="panel-kicker">首次配置</p>
              <h1>WeFlow 初始引导</h1>
              <p className="panel-subtitle">一步一步完成数据库与密钥设置</p>
            </div>
          </div>
          <div className="step-list">
            {steps.map((step, index) => (
              <div key={step.id} className={`step-item ${index === stepIndex ? 'active' : ''} ${index < stepIndex ? 'done' : ''}`}>
                <div className="step-index">{index < stepIndex ? <CheckCircle2 size={14} /> : index + 1}</div>
                <div>
                  <div className="step-title">{step.title}</div>
                  <div className="step-desc">{step.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="panel-foot">
            <ShieldCheck size={16} />
            <span>数据仅在本地处理，不上传服务器</span>
          </div>
        </div>

        <div className="setup-card">
          <div className="setup-header">
            <div className="setup-icon">
              {currentStep.id === 'intro' && <Sparkles size={18} />}
              {currentStep.id === 'db' && <Database size={18} />}
              {currentStep.id === 'cache' && <HardDrive size={18} />}
              {currentStep.id === 'key' && <KeyRound size={18} />}
              {currentStep.id === 'image' && <ShieldCheck size={18} />}
            </div>
            <div>
              <h2>{currentStep.title}</h2>
              <p>{currentStep.desc}</p>
            </div>
          </div>

          {currentStep.id === 'intro' && (
            <div className="setup-body">
              <div className="intro-card">
                <Wand2 size={18} />
                <div>
                  <h3>准备好了吗？</h3>
                  <p>接下来只需配置数据库目录和获取解密密钥。</p>
                </div>
              </div>
            </div>
          )}

          {currentStep.id === 'db' && (
            <div className="setup-body">
              <label className="field-label">数据库根目录</label>
              <input
                type="text"
                className="field-input"
                placeholder="例如：C:\\Users\\xxx\\Documents\\xwechat_files"
                value={dbPath}
                onChange={(e) => setDbPath(e.target.value)}
              />
              <div className="button-row">
                <button className="btn btn-secondary" onClick={handleAutoDetectPath} disabled={isDetectingPath}>
                  <FolderSearch size={16} /> {isDetectingPath ? '检测中...' : '自动检测'}
                </button>
                <button className="btn btn-primary" onClick={handleSelectPath}>
                  <FolderOpen size={16} /> 浏览选择
                </button>
              </div>
              <div className="field-hint">建议选择包含 xwechat_files 的目录</div>
            </div>
          )}

          {currentStep.id === 'cache' && (
            <div className="setup-body">
              <label className="field-label">缓存目录</label>
              <input
                type="text"
                className="field-input"
                placeholder="留空使用默认目录"
                value={cachePath}
                onChange={(e) => setCachePath(e.target.value)}
              />
              <div className="button-row">
                <button className="btn btn-primary" onClick={handleSelectCachePath}>
                  <FolderOpen size={16} /> 浏览选择
                </button>
                <button className="btn btn-secondary" onClick={() => setCachePath('')}>
                  <RotateCcw size={16} /> 使用默认
                </button>
              </div>
              <div className="field-hint">用于头像、表情与图片缓存，留空使用默认目录</div>
            </div>
          )}

          {currentStep.id === 'key' && (
            <div className="setup-body">
              <label className="field-label">微信账号 wxid</label>
              <input
                type="text"
                className="field-input"
                placeholder="获取密钥后将自动填充"
                value={wxid}
                onChange={(e) => setWxid(e.target.value)}
              />
              <label className="field-label">解密密钥</label>
              <div className="field-with-toggle">
                <input
                  type={showDecryptKey ? 'text' : 'password'}
                  className="field-input"
                  placeholder="64 位十六进制密钥"
                  value={decryptKey}
                  onChange={(e) => setDecryptKey(e.target.value.trim())}
                />
                <button type="button" className="toggle-btn" onClick={() => setShowDecryptKey(!showDecryptKey)}>
                  {showDecryptKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>

              {isManualStartPrompt ? (
                <div className="manual-prompt">
                  <p className="prompt-text">未能自动启动微信，请手动启动并登录后点击下方确认</p>
                  <button className="btn btn-primary" onClick={handleManualConfirm}>
                    我已启动微信，继续检测
                  </button>
                </div>
              ) : (
                <button className="btn btn-secondary btn-inline" onClick={handleAutoGetDbKey} disabled={isFetchingDbKey}>
                  {isFetchingDbKey ? '获取中...' : '自动获取密钥'}
                </button>
              )}

              {dbKeyStatus && <div className="field-hint status-text">{dbKeyStatus}</div>}
              <div className="field-hint">获取密钥会自动识别最近登录的账号</div>
            </div>
          )}

          {currentStep.id === 'image' && (
            <div className="setup-body">
              <label className="field-label">图片 XOR 密钥</label>
              <input
                type="text"
                className="field-input"
                placeholder="例如：0xA4"
                value={imageXorKey}
                onChange={(e) => setImageXorKey(e.target.value)}
              />
              <label className="field-label">图片 AES 密钥</label>
              <input
                type="text"
                className="field-input"
                placeholder="16 位密钥"
                value={imageAesKey}
                onChange={(e) => setImageAesKey(e.target.value)}
              />
              <button className="btn btn-secondary btn-inline" onClick={handleAutoGetImageKey} disabled={isFetchingImageKey}>
                {isFetchingImageKey ? '获取中...' : '自动获取图片密钥'}
              </button>
              {imageKeyStatus && <div className="field-hint status-text">{imageKeyStatus}</div>}
              <div className="field-hint">如获取失败，请先打开朋友圈图片再重试</div>
            </div>
          )}

          {error && <div className="error-message">{error}</div>}

          <div className="setup-actions">
            <button className="btn btn-tertiary" onClick={handleBack} disabled={stepIndex === 0}>
              <ArrowLeft size={16} /> 上一步
            </button>
            {stepIndex < steps.length - 1 ? (
              <button className="btn btn-primary" onClick={handleNext} disabled={!canGoNext()}>
                下一步 <ArrowRight size={16} />
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleConnect} disabled={isConnecting || !canGoNext()}>
                {isConnecting ? '连接中...' : '测试并完成'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default WelcomePage

