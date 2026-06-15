import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  ArrowLeft, ArrowRight, CheckCircle2, Database, Eye, EyeOff,
  FolderOpen, FolderSearch, KeyRound, ShieldCheck, Sparkles,
  UserRound, Wand2, Minus, X, HardDrive, RotateCcw
} from 'lucide-react'
import ConfirmDialog from '../components/ConfirmDialog'
import './WelcomePage.scss'

const isMac = navigator.userAgent.toLowerCase().includes('mac')
const isLinux = navigator.userAgent.toLowerCase().includes('linux')
const isWindows = !isMac && !isLinux
const MAC_KEY_FAQ_URL = 'https://github.com/hicccc77/WeFlow/blob/main/docs/MAC-KEY-FAQ.md'

const DB_PATH_CHINESE_ERROR = '路径包含中文字符，迁移至全英文目录后再试'
const dbPathPlaceholder = isMac
    ? '例如: ~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
    : isLinux
        ? '例如: ~/.local/share/WeChat/xwechat_files 或者 ~/Documents/xwechat_files'
        : '例如: C:\\Users\\xxx\\Documents\\xwechat_files'

const steps = [
  { id: 'intro', title: '欢迎', desc: '准备开始你的本地数据探索' },
  { id: 'db', title: '数据库目录', desc: `定位 xwechat_files 目录` },
  { id: 'cache', title: '缓存目录', desc: '设置本地缓存存储位置（可选）' },
  { id: 'key', title: '解密密钥', desc: '获取密钥与自动识别账号' },
  { id: 'image', title: '图片密钥', desc: '获取 XOR 与 AES 密钥' },
  { id: 'security', title: '安全防护', desc: '保护你的数据' }
]
type SetupStepId = typeof steps[number]['id']
type ImageKeyResolveSource = 'manual-cache' | 'prefetch-cache' | 'memory-scan'

interface WelcomePageProps {
  standalone?: boolean
}

const formatDbKeyFailureMessage = (error?: string, logs?: string[]): string => {
  const base = String(error || '自动获取密钥失败').trim()
  const isInternalLine = (line: string): boolean => {
    const lower = line.toLowerCase()
    return lower.includes('xkey_helper')
      || lower.includes('[debug]')
      || lower.includes('breakpoint')
      || lower.includes('hook installed @')
      || lower.includes('scanner ')
  }
  const tailLogs = Array.isArray(logs)
    ? logs
      .map(item => String(item || '').trim())
      .filter(item => Boolean(item) && !isInternalLine(item))
      .map(item => item.length > 80 ? `${item.slice(0, 80)}...` : item)
      .slice(-6)
    : []
  if (tailLogs.length === 0) return base
  return `${base}；最近状态：${tailLogs.join(' | ')}`
}

const normalizeDbKeyStatusMessage = (message: string): string => {
  if (isWindows && message.includes('Hook安装成功')) {
    return '已准备就绪，现在登录微信或退出登录后重新登录微信'
  }
  return message
}

const isDbKeyReadyMessage = (message: string): boolean => {
  if (isWindows) {
    return message.includes('现在可以登录')
      || message.includes('Hook安装成功')
      || message.includes('已准备就绪，现在登录微信或退出登录后重新登录微信')
  }
  return message.includes('现在可以登录')
}

const pickLatestWxid = (
  wxids: Array<{ wxid: string; modifiedTime: number }>
): string => {
  if (!Array.isArray(wxids) || wxids.length === 0) return ''
  const fallbackWxid = wxids[0]?.wxid || ''
  const valid = wxids.filter(item => Number.isFinite(item.modifiedTime) && item.modifiedTime > 0)
  if (valid.length === 0) return fallbackWxid

  const latest = [...valid].sort((a, b) => {
    if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
    return a.wxid.localeCompare(b.wxid)
  })
  return latest[0]?.wxid || fallbackWxid
}

function WelcomePage({ standalone = false }: WelcomePageProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { isDbConnected, setDbConnected, setLoading } = useAppStore()
  const isAddAccountMode = standalone && new URLSearchParams(location.search).get('mode') === 'add-account'

  const [stepIndex, setStepIndex] = useState(0)
  const [dbPath, setDbPath] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [cachePath, setCachePath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<Array<{
      avatarUrl?: string;
      nickname?: string;
      wxid: string;
      modifiedTime: number
  }>>([])
  const [showWxidSelect, setShowWxidSelect] = useState(false)
  const wxidSelectRef = useRef<HTMLDivElement>(null)
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
  const [imageKeyPercent, setImageKeyPercent] = useState<number | null>(null)
  const [isImageKeyVerified, setIsImageKeyVerified] = useState(false)
  const [isImageStepAutoCompleted, setIsImageStepAutoCompleted] = useState(false)
  const [hasReacquiredDbKey, setHasReacquiredDbKey] = useState(!isAddAccountMode)
  const [showDbKeyConfirm, setShowDbKeyConfirm] = useState(false)
  const [lastDbKeyError, setLastDbKeyError] = useState('')
  const imagePrefetchAttemptRef = useRef<string>('')

  // 安全相关 state
  const [enableAuth, setEnableAuth] = useState(false)
  const [authPassword, setAuthPassword] = useState('')
  const [authConfirmPassword, setAuthConfirmPassword] = useState('')
  const [enableHello, setEnableHello] = useState(false)
  const [helloAvailable, setHelloAvailable] = useState(false)
  const [isSettingHello, setIsSettingHello] = useState(false)

  // 检查 Hello 可用性
  useEffect(() => {
    setHelloAvailable(isWindows)
  }, [])

  async function sha256(message: string) {
    const msgBuffer = new TextEncoder().encode(message)
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    return hashHex
  }

  const handleSetupHello = async () => {
    if (!isWindows) {
      setError('当前系统不支持 Windows Hello')
      return
    }
    if (!authPassword || authPassword !== authConfirmPassword) {
      setError('请先设置并确认应用密码，再开启 Windows Hello')
      return
    }

    setIsSettingHello(true)
    try {
      const result = await window.electronAPI.auth.hello('请验证您的身份以开启 Windows Hello')
      if (!result.success) {
        setError(`Windows Hello 设置失败: ${result.error || '验证失败'}`)
        return
      }

      setEnableHello(true)
      setError('')
    } catch (e: any) {
      setError(`Windows Hello 设置失败: ${e?.message || String(e)}`)
    } finally {
      setIsSettingHello(false)
    }
  }

  useEffect(() => {
    const removeDb = window.electronAPI.key.onDbKeyStatus((payload: { message: string; level: number }) => {
      const normalizedMessage = normalizeDbKeyStatusMessage(payload.message)
      setDbKeyStatus(normalizedMessage)
      if (isDbKeyReadyMessage(normalizedMessage)) {
        window.electronAPI.notification?.show({
          title: 'WeFlow 准备就绪',
          content: '现在可以登录微信了',
          avatarUrl: './logo.png',
          sessionId: 'weflow-system'
        })
      }
    })
    const removeImage = window.electronAPI.key.onImageKeyStatus((payload: { message: string, percent?: number }) => {
      let msg = payload.message;
      let pct = payload.percent;

      // 解析文本中的百分比
      if (pct === undefined) {
        const match = msg.match(/\(([\d.]+)%\)/);
        if (match) {
          pct = parseFloat(match[1]);
          msg = msg.replace(/\s*\([\d.]+%\)/, '');
        }
      }

      setImageKeyStatus(msg);
      if (pct !== undefined) {
        setImageKeyPercent(pct);
      } else if (msg.includes('启动多核') || msg.includes('定位') || msg.includes('准备')) {
        setImageKeyPercent(0);
      }
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
    setShowWxidSelect(false)
    setIsImageKeyVerified(false)
    setIsImageStepAutoCompleted(false)
    if (isAddAccountMode) {
      setHasReacquiredDbKey(false)
      setDecryptKey('')
    }
    imagePrefetchAttemptRef.current = ''
  }, [dbPath, isAddAccountMode])

  useEffect(() => {
    if (!isAddAccountMode) return
    let cancelled = false

    const hydrateAddAccountMode = async () => {
      const keyStepIndex = steps.findIndex(step => step.id === 'key')
      if (keyStepIndex >= 0) {
        setStepIndex(keyStepIndex)
      }

      try {
        const [
          savedDbPath,
          savedCachePath,
          savedWxid,
          savedImageXorKey,
          savedImageAesKey
        ] = await Promise.all([
          configService.getDbPath(),
          configService.getCachePath(),
          configService.getMyWxid(),
          configService.getImageXorKey(),
          configService.getImageAesKey()
        ])
        if (cancelled) return

        setDbPath(savedDbPath || '')
        setCachePath(savedCachePath || '')
        setDecryptKey('')
        setHasReacquiredDbKey(false)
        if (typeof savedImageXorKey === 'number' && Number.isFinite(savedImageXorKey)) {
          setImageXorKey(`0x${savedImageXorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        }
        setImageAesKey(savedImageAesKey || '')

        if (savedDbPath) {
          const scannedWxids = await window.electronAPI.dbPath.scanWxids(savedDbPath)
          if (cancelled) return
          setWxidOptions(scannedWxids)

          const preferredWxid = String(savedWxid || '').trim()
          const matched = scannedWxids.find(item => item.wxid === preferredWxid)
          if (matched) {
            setWxid(matched.wxid)
          } else if (preferredWxid) {
            setWxid(preferredWxid)
          } else if (scannedWxids.length > 0) {
            setWxid(scannedWxids[0].wxid)
          }
        } else if (savedWxid) {
          setWxid(savedWxid)
        }
      } catch (e) {
        if (!cancelled) {
          setError(`加载当前账号配置失败: ${e}`)
        }
      }
    }

    void hydrateAddAccountMode()
    return () => {
      cancelled = true
    }
  }, [isAddAccountMode])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!showWxidSelect) return
      const target = event.target as Node
      if (wxidSelectRef.current && !wxidSelectRef.current.contains(target)) {
        setShowWxidSelect(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showWxidSelect])

  const imageStepIndex = steps.findIndex(step => step.id === 'image')
  const securityStepIndex = steps.findIndex(step => step.id === 'security')
  const currentStep = steps[stepIndex] ?? steps[0]
  const imagePreCompletedAhead = isImageStepAutoCompleted && imageStepIndex >= 0 && stepIndex < imageStepIndex
  const rootClassName = `welcome-page${isClosing ? ' is-closing' : ''}${standalone ? ' is-standalone' : ''}`
  const showWindowControls = standalone

  const isStepCompleted = (index: number, stepId: SetupStepId): boolean => {
    if (index < stepIndex) return true
    if (stepId === 'image' && isImageStepAutoCompleted) return true
    if (isAddAccountMode && stepId !== 'key') return true
    return false
  }

  const resolveStepDesc = (step: { id: SetupStepId; desc: string }): string => {
    if (step.id === 'image' && isImageStepAutoCompleted) {
      return '缓存校验成功，已自动完成'
    }
    if (isAddAccountMode && step.id !== 'key') {
      return '已沿用当前配置'
    }
    return step.desc
  }

  const handleMinimize = () => {
    window.electronAPI.window.minimize()
  }

  const handleCloseWindow = () => {
    window.electronAPI.window.close()
  }

  const validatePath = (path: string): string | null => {
    if (!path) return null
    // 检测中文字符和其他可能有问题的特殊字符
    if (/[\u4e00-\u9fa5]/.test(path)) {
      return DB_PATH_CHINESE_ERROR
    }
    return null
  }
  const dbPathValidationError = validatePath(dbPath)

  const handleDbPathChange = (value: string) => {
    setDbPath(value)
    const validationError = validatePath(value)
    if (validationError) {
      setError(validationError)
      return
    }
    if (error === DB_PATH_CHINESE_ERROR) {
      setError('')
    }
  }

  const handleSelectPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信数据库目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0]
        const validationError = validatePath(selectedPath)
        setDbPath(selectedPath)
        if (validationError) {
          setError(validationError)
        } else {
          setError('')
        }
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
        const validationError = validatePath(result.path)
        setDbPath(result.path)
        if (validationError) {
          setError(validationError)
        } else {
          setError('')
        }
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
        // 自动获取密钥后，始终优先选择最近活跃（modifiedTime 最新）的账号。
        const selectedWxid = pickLatestWxid(wxids)
        setWxid(selectedWxid || wxids[0].wxid)
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

  const handleScanWxidCandidates = async () => {
    if (!dbPath) {
      setError('请先选择数据库目录')
      return
    }
    if (isScanningWxid) return
    setIsScanningWxid(true)
    setError('')
    try {
      const wxids = await window.electronAPI.dbPath.scanWxidCandidates(dbPath)
      setWxidOptions(wxids)
      setShowWxidSelect(true)
      if (!wxids.length) {
        setError('未检测到可用的账号目录，请检查路径')
      }
    } catch (e) {
      setError(`扫描失败: ${e}`)
    } finally {
      setIsScanningWxid(false)
    }
  }

  const handleAutoGetDbKey = async () => {
    if (isFetchingDbKey) return
    setShowDbKeyConfirm(true)
  }

  const handleDbKeyConfirm = async () => {
    setShowDbKeyConfirm(false)
    setIsFetchingDbKey(true)
    setError('')
    setLastDbKeyError('')
    setIsManualStartPrompt(false)
    setDbKeyStatus('正在连接微信进程...')
    try {
      const result = await window.electronAPI.key.autoGetDbKey()
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setHasReacquiredDbKey(true)
        setDbKeyStatus('密钥获取成功')
        setError('')
        await handleScanWxid(true)
      } else {
        if (isAddAccountMode) {
          setHasReacquiredDbKey(false)
        }
        if (
          result.error?.includes('未找到微信安装路径') ||
          result.error?.includes('启动微信失败') ||
          result.error?.includes('未能自动启动微信') ||
          result.error?.includes('未找到微信进程') ||
          result.error?.includes('微信进程未运行')
        ) {
          setIsManualStartPrompt(true)
          setDbKeyStatus('需要手动启动微信')
          setLastDbKeyError('')
        } else {
          if (result.error?.includes('尚未完成登录')) {
            setDbKeyStatus('请先在微信完成登录后重试')
          }
          const failureMessage = formatDbKeyFailureMessage(result.error, result.logs)
          setError(failureMessage)
          setLastDbKeyError(failureMessage)
        }
      }
    } catch (e) {
      const failureMessage = `自动获取密钥失败: ${e}`
      setError(failureMessage)
      setLastDbKeyError(failureMessage)
    } finally {
      setIsFetchingDbKey(false)
    }
  }

  const openMacKeyFaq = () => {
    void window.electronAPI.shell.openExternal(MAC_KEY_FAQ_URL)
  }

  const handleManualConfirm = async () => {
    setIsManualStartPrompt(false)
    handleAutoGetDbKey()
  }

  const handleAutoGetImageKey = async (
    source: ImageKeyResolveSource = 'manual-cache',
    options?: { silentError?: boolean }
  ) => {
    if (isFetchingImageKey) return
    if (!dbPath) { setError('请先选择数据库目录'); return }
    setIsFetchingImageKey(true)
    if (!options?.silentError) {
      setError('')
    }
    setImageKeyPercent(0)
    setImageKeyStatus(source === 'prefetch-cache' ? '正在预计算图片密钥...' : '正在准备获取图片密钥...')
    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.key.autoGetImageKey(accountPath, wxid)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        const verified = result.verified === true
        setIsImageKeyVerified(verified)
        setIsImageStepAutoCompleted(verified)
        if (verified) {
          setImageKeyStatus(source === 'prefetch-cache' ? '图片密钥已预先自动完成（缓存校验通过）' : '图片密钥获取成功（缓存校验通过）')
        } else {
          setImageKeyStatus('已自动计算图片密钥（未完成校验）')
        }
      } else {
        setIsImageKeyVerified(false)
        setIsImageStepAutoCompleted(false)
        if (!options?.silentError) {
          setError(result.error || '自动获取图片密钥失败')
        }
      }
    } catch (e) {
      setIsImageKeyVerified(false)
      setIsImageStepAutoCompleted(false)
      if (!options?.silentError) {
        setError(`自动获取图片密钥失败: ${e}`)
      }
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const handleScanImageKeyFromMemory = async () => {
    if (isFetchingImageKey) return
    if (!dbPath) { setError('请先选择数据库目录'); return }
    setIsFetchingImageKey(true)
    setError('')
    setImageKeyPercent(0)
    setImageKeyStatus('正在扫描内存...')
    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.key.scanImageKeyFromMemory(accountPath)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        setIsImageKeyVerified(false)
        setIsImageStepAutoCompleted(false)
        setImageKeyStatus('内存扫描成功，已获取图片密钥')
      } else {
        setError(result.error || '内存扫描获取图片密钥失败')
      }
    } catch (e) {
      setError(`内存扫描失败: ${e}`)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  useEffect(() => {
    if (!dbPath || !wxid || decryptKey.length !== 64) return
    const attemptKey = `${dbPath}::${wxid}::${decryptKey}`
    if (imagePrefetchAttemptRef.current === attemptKey) return
    imagePrefetchAttemptRef.current = attemptKey
    void handleAutoGetImageKey('prefetch-cache', { silentError: true })
  }, [dbPath, wxid, decryptKey])

  const jumpToStep = (stepId: SetupStepId) => {
    const targetIndex = steps.findIndex(step => step.id === stepId)
    if (targetIndex >= 0) setStepIndex(targetIndex)
  }

  const validateDbStepBeforeNext = async (): Promise<string | null> => {
    if (!dbPath) return '数据库目录步骤未完成：请先选择数据库目录'
    if (dbPathValidationError) return `数据库目录步骤配置有误：${dbPathValidationError}`
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      if (!Array.isArray(wxids) || wxids.length === 0) {
        return '数据库目录步骤配置有误：当前目录下未找到可用账号数据（缺少 db_storage），请重新选择微信数据目录'
      }
    } catch (e) {
      return `数据库目录步骤配置有误：目录读取失败，请确认该路径可访问（${String(e)}）`
    }
    return null
  }

  const findConfigIssueBeforeConnect = async (): Promise<{ stepId: SetupStepId; message: string } | null> => {
    const dbIssue = await validateDbStepBeforeNext()
    if (dbIssue) return { stepId: 'db', message: dbIssue }

    let scannedWxids: Array<{ wxid: string }> = []
    try {
      scannedWxids = await window.electronAPI.dbPath.scanWxids(dbPath)
    } catch {
      scannedWxids = []
    }

    if (!wxid) {
      return { stepId: 'key', message: '解密密钥步骤未完成：请先选择微信账号 (wxid)' }
    }
    if (!scannedWxids.some(item => item.wxid === wxid)) {
      return { stepId: 'key', message: `解密密钥步骤配置有误：微信账号「${wxid}」不在当前数据库目录中，请重新选择账号` }
    }
    if (!decryptKey || decryptKey.length !== 64) {
      return { stepId: 'key', message: '解密密钥步骤未完成：请填写 64 位解密密钥' }
    }
    return null
  }

  const canGoNext = () => {
    if (isAddAccountMode) {
      if (currentStep.id === 'key') return hasReacquiredDbKey && decryptKey.length === 64 && Boolean(wxid)
      return true
    }
    if (currentStep.id === 'intro') return true
    if (currentStep.id === 'db') return Boolean(dbPath) && !dbPathValidationError
    if (currentStep.id === 'cache') return true
    if (currentStep.id === 'key') return decryptKey.length === 64 && Boolean(wxid)
    if (currentStep.id === 'image') return true
    if (currentStep.id === 'security') {
      if (enableAuth) {
        return authPassword.length > 0 && authPassword === authConfirmPassword
      }
      return true
    }
    return false
  }

  const handleNext = async () => {
    if (isAddAccountMode) {
      await handleConnect()
      return
    }

    if (currentStep.id === 'db') {
      const dbStepIssue = await validateDbStepBeforeNext()
      if (dbStepIssue) {
        setError(dbStepIssue)
        return
      }
    }

    if (!canGoNext()) {
      if (currentStep.id === 'db' && !dbPath) setError('请先选择数据库目录')
      else if (currentStep.id === 'db' && dbPathValidationError) setError(dbPathValidationError)
      if (currentStep.id === 'key') {
        if (decryptKey.length !== 64) setError('密钥长度必须为 64 个字符')
        else if (!wxid) setError('未能自动识别 wxid，请尝试重新获取或检查目录')
      }
      return
    }
    setError('')
    if (currentStep.id === 'key' && isImageStepAutoCompleted && securityStepIndex >= 0) {
      setStepIndex(securityStepIndex)
      return
    }
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1))
  }

  const handleBack = () => {
    if (isAddAccountMode) return
    setError('')
    setStepIndex((prev) => Math.max(prev - 1, 0))
  }

  const handleConnect = async () => {
    if (isAddAccountMode && !hasReacquiredDbKey) {
      setError('请先在当前流程中自动获取一次数据库密钥')
      return
    }

    const configIssue = await findConfigIssueBeforeConnect()
    if (configIssue) {
      setError(configIssue.message)
      jumpToStep(configIssue.stepId)
      return
    }

    setIsConnecting(true)
    setError('')
    setLoading(true, '正在连接数据库...')

    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (!result.success) {
        const errorMessage = result.error || 'WCDB 连接失败'
        if (errorMessage.includes('-3001')) {
          const fallbackIssue = await findConfigIssueBeforeConnect()
          if (fallbackIssue) {
            setError(fallbackIssue.message)
            jumpToStep(fallbackIssue.stepId)
          } else {
            setError(`数据库目录步骤配置有误：${errorMessage}`)
            jumpToStep('db')
          }
        } else {
          setError(errorMessage)
        }
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

      // 保存安全配置
      if (enableAuth && authPassword) {
        const hash = await sha256(authPassword)
        await configService.setAuthEnabled(true)
        await configService.setAuthPassword(hash)
        if (enableHello) {
          const helloResult = await window.electronAPI.auth.setHelloSecret(authPassword)
          if (!helloResult.success) {
            setError('Windows Hello 配置保存失败')
            setLoading(false)
            return
          }
        } else {
          await window.electronAPI.auth.clearHelloSecret()
          await configService.setAuthUseHello(false)
        }
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
              <div key={step.id} className={`nav-item ${index === stepIndex ? 'active' : ''} ${isStepCompleted(index, step.id) ? 'completed' : ''}`}>
                <div className="nav-indicator">
                  {isStepCompleted(index, step.id) ? <CheckCircle2 size={14} /> : <div className="dot" />}
                </div>
                <div className="nav-info">
                  <div className="nav-title">{step.title}</div>
                  <div className="nav-desc">{resolveStepDesc(step)}</div>
                  {step.id === 'image' && imagePreCompletedAhead && (
                    <div className="nav-hint">已预先自动完成</div>
                  )}
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
              {isAddAccountMode && (
                <p className="header-mode-tip">添加账号模式：其他步骤已沿用当前配置，只需重新获取数据库密钥。</p>
              )}
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
                    placeholder={dbPathPlaceholder}
                    value={dbPath}
                    onChange={(e) => handleDbPathChange(e.target.value)}
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
                <div className="wxid-select" ref={wxidSelectRef}>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="点击选择..."
                    value={wxid}
                    readOnly
                    onClick={handleScanWxidCandidates}
                    onChange={(e) => setWxid(e.target.value)}
                  />
                  {showWxidSelect && wxidOptions.length > 0 && (
                      <div className="wxid-dropdown">
                        {wxidOptions.map((opt) => (
                            <button
                                key={opt.wxid}
                                type="button"
                                className={`wxid-option ${opt.wxid === wxid ? 'active' : ''}`}
                                onClick={() => {
                                  setWxid(opt.wxid)
                                  setShowWxidSelect(false)
                                }}
                            >
                              <div className="wxid-profile">
                                {opt.avatarUrl ? (
                                    <img src={opt.avatarUrl} alt="avatar" className="wxid-avatar" />
                                ) : (
                                    <div className="wxid-avatar-fallback"><UserRound size={14}/></div>
                                )}
                                <div className="wxid-info">
                                  <span className="wxid-nickname">{opt.nickname || opt.wxid}</span>
                                  {opt.nickname && <span className="wxid-sub">{opt.wxid}</span>}
                                </div>
                              </div>
                              <span className="wxid-time">{formatModifiedTime(opt.modifiedTime)}</span>
                            </button>
                        ))}
                      </div>
                  )}
                </div>

                <label className="field-label mt-4">解密密钥</label>
                <div className="field-with-toggle">
                  <input
                    type={showDecryptKey ? 'text' : 'password'}
                    className="field-input"
                    placeholder="64 位十六进制密钥"
                    value={decryptKey}
                    onChange={(e) => {
                      const value = e.target.value.trim()
                      setDecryptKey(value)
                      if (value.length === 64) {
                        setHasReacquiredDbKey(true)
                      }
                    }}
                  />
                  <button type="button" className="toggle-btn" onClick={() => setShowDecryptKey(!showDecryptKey)}>
                    {showDecryptKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                <div className="key-actions">
                  {isManualStartPrompt ? (
                    <div className="manual-prompt">
                      <p>未能自动启动微信，请手动启动微信，看到登录窗口后点击下方确认</p>
                      <button className="btn btn-primary" onClick={handleManualConfirm}>
                        我已看到登录窗口，继续
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn-secondary btn-block" onClick={handleAutoGetDbKey} disabled={isFetchingDbKey}>
                      {isFetchingDbKey ? '正在获取...' : '自动获取密钥'}
                    </button>
                  )}
                </div>

                {dbKeyStatus && <div className={`status-message ${isDbKeyReadyMessage(dbKeyStatus) ? 'is-success' : ''}`}>{dbKeyStatus}</div>}
                {isAddAccountMode && !hasReacquiredDbKey && (
                  <div className="field-hint">添加账号模式下需先自动获取一次数据库密钥，才能完成并返回主窗口。</div>
                )}
              </div>
            )}

            {currentStep.id === 'security' && (
              <div className="form-group">
                <div className="security-toggle-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div className="toggle-info">
                    <label className="field-label" style={{ marginBottom: 0 }}>启用应用锁</label>
                    <div className="field-hint">每次启动应用时需要验证密码</div>
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={enableAuth} onChange={e => setEnableAuth(e.target.checked)} />
                    <span className="switch-slider" />
                  </label>
                </div>

                {enableAuth && (
                  <div className="security-settings" style={{ marginTop: 20, padding: 16, backgroundColor: 'var(--bg-secondary)', borderRadius: 8 }}>
                    <div className="form-group">
                      <label className="field-label">应用密码</label>
                      <input
                        type="password"
                        className="field-input"
                        placeholder="请输入密码"
                        value={authPassword}
                        onChange={e => setAuthPassword(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label className="field-label">确认密码</label>
                      <input
                        type="password"
                        className="field-input"
                        placeholder="请再次输入密码"
                        value={authConfirmPassword}
                        onChange={e => setAuthConfirmPassword(e.target.value)}
                      />
                      {authPassword && authConfirmPassword && authPassword !== authConfirmPassword && (
                        <div className="error-text" style={{ color: '#ff4d4f', fontSize: 12, marginTop: 4 }}>两次密码不一致</div>
                      )}
                    </div>

                    <div className="divider" style={{ margin: '20px 0', borderTop: '1px solid var(--border-color)' }}></div>

                    <div className="security-toggle-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="toggle-info">
                        <label className="field-label" style={{ marginBottom: 0 }}>Windows Hello</label>
                        <div className="field-hint">使用面容、指纹或 PIN 码快速解锁</div>
                      </div>

                      {enableHello ? (
                        <div style={{ color: '#52c41a', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <CheckCircle2 size={16} /> 已开启
                          <button className="btn btn-ghost btn-sm" onClick={() => setEnableHello(false)} style={{ padding: '2px 8px', height: 24, fontSize: 12 }}>关闭</button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={!helloAvailable || isSettingHello}
                          onClick={handleSetupHello}
                        >
                          {isSettingHello ? '设置中...' : (helloAvailable ? '点击开启' : '不可用')}
                        </button>
                      )}
                    </div>
                    {!helloAvailable && <div className="field-hint warning"> 当前设备不支持 Windows Hello 或未设置 PIN 码</div>}
                  </div>
                )}
              </div>
            )}

            {currentStep.id === 'image' && (
              <div className="form-group">
                <div className="auto-image-key-preview">
                  <div className="auto-image-key-row">
                    <span className="auto-image-key-label">图片 XOR 密钥</span>
                    <code>{imageXorKey || '等待自动计算'}</code>
                  </div>
                  <div className="auto-image-key-row">
                    <span className="auto-image-key-label">图片 AES 密钥</span>
                    <code>{imageAesKey || '等待自动计算'}</code>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                  <button className="btn btn-primary btn-block" onClick={() => handleAutoGetImageKey('manual-cache')} disabled={isFetchingImageKey} title="从本地缓存快速计算">
                    {isFetchingImageKey ? '获取中...' : '缓存计算（推荐）'}
                  </button>
                  <button className="btn btn-secondary btn-block" onClick={handleScanImageKeyFromMemory} disabled={isFetchingImageKey} title="扫描微信进程内存">
                    {isFetchingImageKey ? '扫描中...' : '内存扫描'}
                  </button>
                </div>

                {isFetchingImageKey ? (
                  <div className="brute-force-progress">
                    <div className="status-header">
                      <span className="status-text">{imageKeyStatus || '正在启动...'}</span>
                      {typeof imageKeyPercent === 'number' && Number.isFinite(imageKeyPercent) && (
                        <span className="status-text">{Math.max(0, Math.min(100, imageKeyPercent)).toFixed(1)}%</span>
                      )}
                    </div>
                  </div>
                ) : (
                  imageKeyStatus && <div className="status-message" style={{ marginTop: '12px' }}>{imageKeyStatus}</div>
                )}

                <div className="field-hint" style={{ marginTop: '8px' }}>
                  图片密钥已改为自动计算。仅当"缓存计算 + 本地校验通过"时会自动跳过本步骤；若失败可使用内存扫描兜底。
                </div>
                {isImageKeyVerified && (
                  <div className="status-message is-success" style={{ marginTop: '8px' }}>
                    当前密钥已通过缓存校验，可安全自动跳过图片密钥步骤。
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="error-message">
              <div className="error-text">{error}</div>
              {isMac && error === lastDbKeyError && (
                <button type="button" className="error-link-btn" onClick={openMacKeyFaq}>
                  查看 macOS 获取密钥排障指引
                </button>
              )}
            </div>
          )}

          {currentStep.id === 'intro' && (
            <div className="intro-footer">
              <p>接下来的几个步骤将引导你连接本地微信数据库。</p>
              <p>WeFlow 需要访问你的本地数据文件以提供分析与导出功能。</p>
            </div>
          )}

          <div className="content-actions">
            <button className="btn btn-ghost" onClick={handleBack} disabled={stepIndex === 0 || isAddAccountMode}>
              <ArrowLeft size={16} /> 上一步
            </button>

            {isAddAccountMode ? (
              <button className="btn btn-primary" onClick={handleConnect} disabled={isConnecting || !canGoNext()}>
                {isConnecting ? '连接中...' : '完成并返回'} <ArrowRight size={16} />
              </button>
            ) : stepIndex < steps.length - 1 ? (
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

        <ConfirmDialog
            open={showDbKeyConfirm}
            title="开始获取数据库密钥"
            message={`当开始获取后 WeFlow 将会执行准备操作。
${isLinux ? `
【⚠️ Linux 用户特别注意】
如果您在微信里勾选了“自动登录”，请务必先关闭自动登录，然后再点击下方确认！
（因为授权弹窗输入密码需要时间，若自动登录太快会导致获取失败）
` : ''}
当 WeFlow 内的提示条变为绿色显示允许登录或看到来自 WeFlow 的登录通知时，请在手机上确认登录微信。`}
            onConfirm={handleDbKeyConfirm}
            onCancel={() => setShowDbKeyConfirm(false)}
        />
      </div>
    </div>
  )
}

export default WelcomePage
