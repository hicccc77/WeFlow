import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  ArrowLeft, ArrowRight, CheckCircle2, Database, Eye, EyeOff,
  FolderOpen, FolderSearch, KeyRound, ShieldCheck, Sparkles,
  UserRound, Wand2, Minus, X
} from 'lucide-react'
import './WelcomePage.scss'

const steps = [
  { id: 'intro', title: '欢迎', desc: '准备开始你的本地数据探索' },
  { id: 'db', title: '数据库目录', desc: '定位 xwechat_files 目录' },
  { id: 'wxid', title: '微信账号', desc: '选择或输入 wxid' },
  { id: 'key', title: '解密密钥', desc: '填写 64 位十六进制密钥' },
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

  const handleScanWxid = async () => {
    if (!dbPath) {
      setError('请先选择数据库目录')
      return
    }
    if (isScanningWxid) return
    setIsScanningWxid(true)
    setError('')
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setWxidOptions(wxids)
      if (wxids.length === 1) {
        setWxid(wxids[0].wxid)
        setError('')
      } else if (wxids.length > 1) {
        setError(`检测到 ${wxids.length} 个账号，请在下方选择`)
      } else {
        setError('未检测到账号目录，请检查路径')
      }
    } catch (e) {
      setError(`扫描失败: ${e}`)
    } finally {
      setIsScanningWxid(false)
    }
  }

  const handleAutoGetDbKey = async () => {
    if (isFetchingDbKey) return
    setIsFetchingDbKey(true)
    setError('')
    setDbKeyStatus('正在连接微信进程...')
    try {
      const result = await window.electronAPI.key.autoGetDbKey()
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setDbKeyStatus('密钥获取成功')
        setError('')
      } else {
        setError(result.error || '自动获取密钥失败')
      }
    } catch (e) {
      setError(`自动获取密钥失败: ${e}`)
    } finally {
      setIsFetchingDbKey(false)
    }
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
      const result = await window.electronAPI.key.autoGetImageKey(dbPath)
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
    if (currentStep.id === 'wxid') return Boolean(wxid)
    if (currentStep.id === 'key') return decryptKey.length === 64
    if (currentStep.id === 'image') return true
    return false
  }

  const handleNext = () => {
    if (!canGoNext()) {
      if (currentStep.id === 'db' && !dbPath) setError('请先选择数据库目录')
      if (currentStep.id === 'wxid' && !wxid) setError('请填写 wxid')
      if (currentStep.id === 'key' && decryptKey.length !== 64) setError('密钥长度必须为 64 个字符')
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
              {currentStep.id === 'key' && <KeyRound size={18} />}
              {currentStep.id === 'image' && <ShieldCheck size={18} />}
              {currentStep.id === 'wxid' && <UserRound size={18} />}
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
                  <p>接下来只需配置数据库目录、解密密钥和微信账号。</p>
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

          {currentStep.id === 'key' && (
            <div className="setup-body">
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
              <button className="btn btn-secondary btn-inline" onClick={handleAutoGetDbKey} disabled={isFetchingDbKey}>
                {isFetchingDbKey ? '获取中...' : '自动获取密钥'}
              </button>
              {dbKeyStatus && <div className="field-hint status-text">{dbKeyStatus}</div>}
              <div className="field-hint">长度必须为 64 个字符</div>
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

          {currentStep.id === 'wxid' && (
            <div className="setup-body">
              <label className="field-label">微信账号 wxid</label>
              <input
                type="text"
                className="field-input"
                placeholder="例如：wxid_xxxxxx"
                value={wxid}
                onChange={(e) => setWxid(e.target.value)}
              />
              {wxidOptions.length > 0 && (
                <div className="wxid-options">
                  {wxidOptions.map((option) => (
                    <button
                      key={option.wxid}
                      type="button"
                      className={`wxid-option${option.wxid === wxid ? ' is-selected' : ''}`}
                      onClick={() => {
                        setWxid(option.wxid)
                        setError('')
                      }}
                    >
                      <span className="wxid-option-name">{option.wxid}</span>
                      <span className="wxid-option-time">{formatModifiedTime(option.modifiedTime)}</span>
                    </button>
                  ))}
                </div>
              )}
              <button className="btn btn-secondary btn-inline" onClick={handleScanWxid} disabled={isScanningWxid}>
                {isScanningWxid ? '扫描中...' : '扫描 wxid'}
              </button>
              <div className="field-hint">如无法自动扫描，请手动输入</div>
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

