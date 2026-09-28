import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  ArrowLeft, ArrowRight, CheckCircle2, Database, Eye, EyeOff,
  FolderOpen, KeyRound, ShieldCheck, Sparkles,
  Wand2, Minus, X, HardDrive, RotateCcw
} from 'lucide-react'
import ConfirmDialog from '../components/ConfirmDialog'
import ErrorReferenceLink from '../components/ErrorReferenceLink'
import './WelcomePage.scss'

const isMac = navigator.userAgent.toLowerCase().includes('mac')
const isLinux = navigator.userAgent.toLowerCase().includes('linux')
const isWindows = !isMac && !isLinux

const DB_PATH_CHINESE_ERROR = '路径包含中文字符，迁移至全英文目录后再试'
const dbPathPlaceholder = '请输入或选择数据所在的根目录'

const steps = [
  { id: 'intro', title: '欢迎', desc: '准备开始你的本地数据探索' },
  { id: 'db', title: '数据库目录', desc: '定位数据根目录' },
  { id: 'cache', title: '缓存目录', desc: '设置本地缓存存储位置（可选）' },
  { id: 'key', title: '解密密钥', desc: '获取密钥并填写账号 ID' },
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

// 密钥获取工具由用户自备，进度文案不再是固定词表，这里仅做直通展示。
const normalizeDbKeyStatusMessage = (message: string): string => message

const isDbKeyReadyMessage = (message: string): boolean => {
  return message.includes('现在可以登录') || message.includes('现在请登录目标应用')
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
  const [accountId, setAccountId] = useState('')
  const [error, setError] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
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
  const imageAutoAttemptRef = useRef<string>('')

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
          content: '现在请登录目标应用，并在手机上确认登录',
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
    setAccountId('')
    setIsImageKeyVerified(false)
    setIsImageStepAutoCompleted(false)
    if (isAddAccountMode) {
      setHasReacquiredDbKey(false)
      setDecryptKey('')
    }
    imagePrefetchAttemptRef.current = ''
    imageAutoAttemptRef.current = ''
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
          savedAccountId
        ] = await Promise.all([
          configService.getDbPath(),
          configService.getCachePath(),
          configService.getMyAccountId()
        ])
        if (cancelled) return

        setDbPath(savedDbPath || '')
        setCachePath(savedCachePath || '')
        setDecryptKey('')
        setHasReacquiredDbKey(false)
        setImageXorKey('')
        setImageAesKey('')
        setIsImageKeyVerified(false)
        setIsImageStepAutoCompleted(false)
        setImageKeyStatus('')

        if (savedAccountId) {
          setAccountId(savedAccountId)
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

  const imageStepIndex = steps.findIndex(step => step.id === 'image')
  const securityStepIndex = steps.findIndex(step => step.id === 'security')
  const currentStep = steps[stepIndex] ?? steps[0]
  const imagePreCompletedAhead = isImageStepAutoCompleted && imageStepIndex >= 0 && stepIndex < imageStepIndex
  const rootClassName = `welcome-page${isClosing ? ' is-closing' : ''}${standalone ? ' is-standalone' : ''}`
  const showWindowControls = standalone

  const isStepCompleted = (index: number, stepId: SetupStepId): boolean => {
    if (index < stepIndex) return true
    if (stepId === 'image' && isImageStepAutoCompleted) return true
    if (isAddAccountMode && stepId !== 'key' && stepId !== 'image') return true
    return false
  }

  const resolveStepDesc = (step: { id: SetupStepId; desc: string }): string => {
    if (step.id === 'image' && isImageStepAutoCompleted) {
      return '缓存校验成功，已自动完成'
    }
    if (isAddAccountMode && step.id !== 'key' && step.id !== 'image') {
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
        title: '选择数据库目录',
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

  const handleAutoGetDbKey = async () => {
    if (isFetchingDbKey) return
    setShowDbKeyConfirm(true)
  }

  const handleDbKeyConfirm = async () => {
    window.electronAPI.key.trace?.('renderer:welcome:confirm', { dbPath, accountId })
    setShowDbKeyConfirm(false)
    setIsFetchingDbKey(true)
    setError('')
    setLastDbKeyError('')
    setIsManualStartPrompt(false)
    setDbKeyStatus('正在连接目标应用进程...')
    try {
      window.electronAPI.key.trace?.('renderer:welcome:invoke-before', { dbPath, accountId })
      const result = await window.electronAPI.key.autoGetDbKey(dbPath, accountId)
      window.electronAPI.key.trace?.('renderer:welcome:invoke-after', {
        success: result.success,
        hasKey: Boolean(result.key),
        accountId: result.accountId,
        error: result.error
      })
      if (result.success && result.key) {
        setDecryptKey(result.key)
        if (result.accountId) {
          setAccountId(result.accountId)
        }
        setHasReacquiredDbKey(true)
        setDbKeyStatus('密钥获取成功')
        setError('')
      } else {
        if (isAddAccountMode) {
          setHasReacquiredDbKey(false)
        }
        if (
          result.error?.includes('未找到安装路径') ||
          result.error?.includes('启动失败') ||
          result.error?.includes('未能自动启动') ||
          result.error?.includes('未找到目标应用进程') ||
          result.error?.includes('目标应用进程未运行')
        ) {
          setIsManualStartPrompt(true)
          setDbKeyStatus('需要手动启动目标应用')
          setLastDbKeyError('')
        } else {
          if (result.error?.includes('尚未完成登录')) {
            setDbKeyStatus('请先在目标应用完成登录后重试')
          }
          const failureMessage = formatDbKeyFailureMessage(result.error, result.logs)
          setError(failureMessage)
          setLastDbKeyError(failureMessage)
        }
      }
    } catch (e) {
      window.electronAPI.key.trace?.('renderer:welcome:error', { error: String(e) })
      const failureMessage = `自动获取密钥失败: ${e}`
      setError(failureMessage)
      setLastDbKeyError(failureMessage)
    } finally {
      window.electronAPI.key.trace?.('renderer:welcome:finally')
      setIsFetchingDbKey(false)
    }
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
      const accountPath = accountId ? `${dbPath}/${accountId}` : dbPath
      const result = await window.electronAPI.key.autoGetImageKey(accountPath, accountId)
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
      const accountPath = accountId ? `${dbPath}/${accountId}` : dbPath
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
    if (!dbPath || !accountId || decryptKey.length !== 64) return
    const attemptKey = `${dbPath}::${accountId}::${decryptKey}`
    if (imagePrefetchAttemptRef.current === attemptKey) return
    imagePrefetchAttemptRef.current = attemptKey
    window.electronAPI.key.trace?.('renderer:welcome:image-prefetch-skipped', { dbPath, accountId })
  }, [dbPath, accountId, decryptKey])

  useEffect(() => {
    if (currentStep.id !== 'image') return
    if (!dbPath || !accountId || isFetchingImageKey) return
    const attemptKey = `${dbPath}::${accountId}`
    if (imageAutoAttemptRef.current === attemptKey) return
    imageAutoAttemptRef.current = attemptKey
    window.electronAPI.key.trace?.('renderer:welcome:image-auto-calc-start', { dbPath, accountId })
    void handleAutoGetImageKey('manual-cache')
  }, [currentStep.id, dbPath, accountId, isFetchingImageKey])

  const jumpToStep = (stepId: SetupStepId) => {
    const targetIndex = steps.findIndex(step => step.id === stepId)
    if (targetIndex >= 0) setStepIndex(targetIndex)
  }

  const validateDbStepBeforeNext = async (): Promise<string | null> => {
    if (!dbPath) return '数据库目录步骤未完成：请先选择数据库目录'
    if (dbPathValidationError) return `数据库目录步骤配置有误：${dbPathValidationError}`
    try {
      const result = await window.electronAPI.account.resolveDir(dbPath)
      if (!result.dbPathExists) {
        return '数据库目录步骤配置有误：目录不存在或无法访问，请重新选择数据目录'
      }
    } catch (e) {
      return `数据库目录步骤配置有误：目录读取失败，请确认该路径可访问（${String(e)}）`
    }
    return null
  }

  const findConfigIssueBeforeConnect = async (): Promise<{ stepId: SetupStepId; message: string } | null> => {
    const dbIssue = await validateDbStepBeforeNext()
    if (dbIssue) return { stepId: 'db', message: dbIssue }

    if (!accountId) {
      return { stepId: 'key', message: '解密密钥步骤未完成：请先填写账号 ID' }
    }
    try {
      const result = await window.electronAPI.account.resolveDir(dbPath, accountId)
      if (!result.accountDir) {
        return { stepId: 'key', message: `解密密钥步骤配置有误：账号「${accountId}」不在当前数据库目录中，请检查账号 ID` }
      }
    } catch {
      return { stepId: 'key', message: '解密密钥步骤配置有误：账号目录读取失败' }
    }
    if (!decryptKey || decryptKey.length !== 64) {
      return { stepId: 'key', message: '解密密钥步骤未完成：请填写 64 位解密密钥' }
    }
    return null
  }

  const canGoNext = () => {
    if (isAddAccountMode) {
      if (currentStep.id === 'key') return hasReacquiredDbKey && decryptKey.length === 64 && Boolean(accountId)
      if (currentStep.id === 'image') return !isFetchingImageKey
      return true
    }
    if (currentStep.id === 'intro') return true
    if (currentStep.id === 'db') return Boolean(dbPath) && !dbPathValidationError
    if (currentStep.id === 'cache') return true
    if (currentStep.id === 'key') return decryptKey.length === 64 && Boolean(accountId)
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
      if (currentStep.id === 'key') {
        if (!canGoNext()) {
          if (decryptKey.length !== 64) setError('密钥长度必须为 64 个字符')
          else if (!accountId) setError('未能自动识别 accountId，请尝试重新获取或检查目录')
          return
        }
        setError('')
        if (imageStepIndex >= 0) {
          setStepIndex(imageStepIndex)
          return
        }
      }
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
        else if (!accountId) setError('未能自动识别 accountId，请尝试重新获取或检查目录')
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
    if (isAddAccountMode) {
      if (currentStep.id === 'image') {
        const keyStepIndex = steps.findIndex(step => step.id === 'key')
        if (keyStepIndex >= 0) {
          setError('')
          setStepIndex(keyStepIndex)
        }
      }
      return
    }
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
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, accountId)
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
      await configService.setMyAccountId(accountId)
      await configService.setCachePath(cachePath)
      const parsedXorKey = imageXorKey ? parseInt(imageXorKey.replace(/^0x/i, ''), 16) : null
      await configService.setImageXorKey(typeof parsedXorKey === 'number' && !Number.isNaN(parsedXorKey) ? parsedXorKey : 0)
      await configService.setImageAesKey(imageAesKey || '')
      await configService.setAccountConfig(accountId, {
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

      // testConnection 会在验证成功后释放临时 WCDB 句柄；同时，上面的关键
      // 配置写入也会让主进程关闭旧连接。此处必须建立正式聊天连接，不能只
      // 在当前（独立引导窗口）renderer 中把 Zustand 状态标记为已连接。
      setLoading(true, '正在打开数据库...')
      const connectResult = await window.electronAPI.chat.connect()
      if (!connectResult.success) {
        setError(connectResult.error || '数据库连接失败，请重试')
        setLoading(false)
        return
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
            <span>聊天数据默认本地处理；AI 功能仅在明确授权后发送文本</span>
          </div>
        </div>

        <div className="welcome-content">
          <div className="content-header">
            <div>
              <h2>{currentStep.title}</h2>
              <p className="header-desc">{currentStep.desc}</p>
              {isAddAccountMode && (
                <p className="header-mode-tip">添加账号模式：数据库目录、缓存目录与安全设置沿用当前配置；数据库密钥和图片密钥需按账号重新处理。</p>
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
                  <button className="btn btn-secondary" onClick={handleSelectPath}>
                    <FolderOpen size={16} /> 浏览...
                  </button>
                </div>

                <div className="field-hint">请选择目标应用设置里的存储位置对应的目录</div>
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
                <label className="field-label">账号 ID</label>
                <div className="input-group">
                  <input
                    type="text"
                    className="field-input"
                    placeholder="请输入账号 ID"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                  />
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
                      <p>未能自动启动目标应用，请手动启动，看到登录窗口后点击下方确认</p>
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
                    {isFetchingImageKey ? '计算中...' : '重新计算'}
                  </button>
                  <button className="btn btn-secondary btn-block" onClick={handleScanImageKeyFromMemory} disabled={isFetchingImageKey} title="扫描目标应用进程内存">
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
                  进入本步骤会自动从缓存计算图片密钥；若缓存校验失败，可重新计算或使用内存扫描。
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
              <ErrorReferenceLink error={error} label="打开报错核对" />
            </div>
          )}

          {currentStep.id === 'intro' && (
            <div className="intro-footer">
              <p>接下来的几个步骤将引导你连接本地数据库。</p>
              <p>WeFlow 需要访问你的本地数据文件以提供分析与导出功能。</p>
            </div>
          )}

          <div className="content-actions">
            <button className="btn btn-ghost" onClick={handleBack} disabled={stepIndex === 0 || (isAddAccountMode && currentStep.id !== 'image')}>
              <ArrowLeft size={16} /> 上一步
            </button>

            {isAddAccountMode ? (
              <button className="btn btn-primary" onClick={handleNext} disabled={isConnecting || !canGoNext()}>
                {currentStep.id === 'image'
                  ? (isConnecting ? '连接中...' : '完成并返回')
                  : '下一步'} <ArrowRight size={16} />
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
            message={isWindows ? '确认目标应用已登录后且只存在一个实例时，开始扫描' : `当开始获取后 WeFlow 将会执行准备操作。

请现在将目标应用退出登录，并保持在未登录状态。
${isLinux ? `
【⚠️ Linux 用户特别注意】
如果您在目标应用里勾选了"自动登录"，请务必先关闭自动登录，然后再点击下方确认！
（因为授权弹窗输入密码需要时间，若自动登录太快会导致获取失败）
` : ''}
当 WeFlow 内的提示条变为绿色显示允许登录或看到来自 WeFlow 的登录通知时，请在手机上确认登录目标应用。`}
            onConfirm={handleDbKeyConfirm}
            onCancel={() => setShowDbKeyConfirm(false)}
        />
      </div>
    </div>
  )
}

export default WelcomePage
