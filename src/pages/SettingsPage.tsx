import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useThemeStore, themes } from '../stores/themeStore'
import { useAnalyticsStore } from '../stores/analyticsStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  Eye, EyeOff, FolderSearch, FolderOpen, Search, Copy,
  RotateCcw, Trash2, Plug, Check, Sun, Moon, Monitor,
  Palette, Database, HardDrive, Info, RefreshCw, ChevronDown, Download, Mic,
  ShieldCheck, Fingerprint, Lock, KeyRound, Bell, Globe, BarChart2, X, UserRound
} from 'lucide-react'
import { Avatar } from '../components/Avatar'
import './SettingsPage.scss'

type SettingsTab = 'appearance' | 'notification' | 'database' | 'models' | 'cache' | 'api' | 'security' | 'about' | 'analytics'

const tabs: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'notification', label: '通知', icon: Bell },
  { id: 'database', label: '数据库连接', icon: Database },
  { id: 'models', label: '模型管理', icon: Mic },
  { id: 'cache', label: '缓存', icon: HardDrive },
  { id: 'api', label: 'API 服务', icon: Globe },

  { id: 'analytics', label: '分析', icon: BarChart2 },
  { id: 'security', label: '安全', icon: ShieldCheck },
  { id: 'about', label: '关于', icon: Info }
]

const isMac = navigator.userAgent.toLowerCase().includes('mac')
const isLinux = navigator.userAgent.toLowerCase().includes('linux')
const isWindows = !isMac && !isLinux

const dbDirName = isMac ? '2.0b4.0.9 目录' : 'xwechat_files 目录'
const dbPathPlaceholder = isMac
    ? '例如: ~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
    : isLinux
        ? '例如: ~/.local/share/WeChat/xwechat_files 或者 ~/Documents/xwechat_files'
        : '例如: C:\\Users\\xxx\\Documents\\xwechat_files'


interface WxidOption {
  wxid: string
  modifiedTime: number
  nickname?: string
  avatarUrl?: string
}

interface SettingsPageProps {
  onClose?: () => void
}

function SettingsPage({ onClose }: SettingsPageProps = {}) {
  const location = useLocation()
  const {
    isDbConnected,
    setDbConnected,
    setLoading,
    reset,
    updateInfo,
    setUpdateInfo,
    isDownloading,
    setIsDownloading,
    downloadProgress,
    setDownloadProgress,
    showUpdateDialog,
    setShowUpdateDialog,
    setUpdateError
  } = useAppStore()

  const resetChatStore = useChatStore((state) => state.reset)
  const { currentTheme, themeMode, setTheme, setThemeMode } = useThemeStore()
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  const effectiveMode = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode
  const clearAnalyticsStoreCache = useAnalyticsStore((state) => state.clearCache)

  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [decryptKey, setDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [dbPath, setDbPath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<WxidOption[]>([])
  const [showWxidSelect, setShowWxidSelect] = useState(false)
  const [cachePath, setCachePath] = useState('')
  const [imageKeyProgress, setImageKeyProgress] = useState(0)
  const [imageKeyPercent, setImageKeyPercent] = useState<number | null>(null)

  const [logEnabled, setLogEnabled] = useState(false)
  const [whisperModelName, setWhisperModelName] = useState('base')
  const [whisperModelDir, setWhisperModelDir] = useState('')
  const [isWhisperDownloading, setIsWhisperDownloading] = useState(false)
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState(0)
  const [whisperProgressData, setWhisperProgressData] = useState<{ downloaded: number; total: number; speed: number }>({ downloaded: 0, total: 0, speed: 0 })
  const [whisperModelStatus, setWhisperModelStatus] = useState<{ exists: boolean; modelPath?: string; tokensPath?: string } | null>(null)

  const [httpApiToken, setHttpApiToken] = useState('')

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const generateRandomToken = async () => {
    // 生成 32 字符的十六进制随机字符串 (16 bytes)
    const array = new Uint8Array(16)
    crypto.getRandomValues(array)
    const token = Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('')

    setHttpApiToken(token)
    await configService.setHttpApiToken(token)
    showMessage('已生成并保存新的 Access Token', true)
  }

  const clearApiToken = async () => {
    setHttpApiToken('')
    await configService.setHttpApiToken('')
    showMessage('已清除 Access Token，API 将允许无鉴权访问', true)
  }



  const [autoTranscribeVoice, setAutoTranscribeVoice] = useState(false)
  const [transcribeLanguages, setTranscribeLanguages] = useState<string[]>(['zh'])

  const [notificationEnabled, setNotificationEnabled] = useState(true)
  const [notificationPosition, setNotificationPosition] = useState<'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center'>('top-right')
  const [notificationFilterMode, setNotificationFilterMode] = useState<'all' | 'whitelist' | 'blacklist'>('all')
  const [notificationFilterList, setNotificationFilterList] = useState<string[]>([])
  const [windowCloseBehavior, setWindowCloseBehavior] = useState<configService.WindowCloseBehavior>('ask')
  const [quoteLayout, setQuoteLayout] = useState<configService.QuoteLayout>('quote-top')
  const [filterSearchKeyword, setFilterSearchKeyword] = useState('')
  const [filterModeDropdownOpen, setFilterModeDropdownOpen] = useState(false)
  const [positionDropdownOpen, setPositionDropdownOpen] = useState(false)
  const [closeBehaviorDropdownOpen, setCloseBehaviorDropdownOpen] = useState(false)

  const [wordCloudExcludeWords, setWordCloudExcludeWords] = useState<string[]>([])
  const [excludeWordsInput, setExcludeWordsInput] = useState('')

  // 数据收集同意状态
  const [analyticsConsent, setAnalyticsConsent] = useState<boolean>(false)





  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [isManualStartPrompt, setIsManualStartPrompt] = useState(false)
  const [isClearingAnalyticsCache, setIsClearingAnalyticsCache] = useState(false)
  const [isClearingImageCache, setIsClearingImageCache] = useState(false)
  const [isClearingAllCache, setIsClearingAllCache] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // 安全设置 state
  const [authEnabled, setAuthEnabled] = useState(false)
  const [authUseHello, setAuthUseHello] = useState(false)
  const [helloAvailable, setHelloAvailable] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [helloPassword, setHelloPassword] = useState('')
  const [disableLockPassword, setDisableLockPassword] = useState('')
  const [showDisableLockInput, setShowDisableLockInput] = useState(false)
  const [isLockMode, setIsLockMode] = useState(false)
  const [isSettingHello, setIsSettingHello] = useState(false)

  // HTTP API 设置 state
  const [httpApiEnabled, setHttpApiEnabled] = useState(false)
  const [httpApiPort, setHttpApiPort] = useState(5031)
  const [httpApiHost, setHttpApiHost] = useState('127.0.0.1')
  const [httpApiRunning, setHttpApiRunning] = useState(false)
  const [httpApiMediaExportPath, setHttpApiMediaExportPath] = useState('')
  const [isTogglingApi, setIsTogglingApi] = useState(false)
  const [showApiWarning, setShowApiWarning] = useState(false)
  const [messagePushEnabled, setMessagePushEnabled] = useState(false)

  const isClearingCache = isClearingAnalyticsCache || isClearingImageCache || isClearingAllCache

  const [isWayland, setIsWayland] = useState(false)
  useEffect(() => {
    const checkWaylandStatus = async () => {
      if (window.electronAPI?.app?.checkWayland) {
        try {
          const wayland = await window.electronAPI.app.checkWayland()
          setIsWayland(wayland)
        } catch (e) {
          console.error('检查 Wayland 状态失败:', e)
        }
      }
    }
    checkWaylandStatus()
  }, [])



  // 检查 Hello 可用性
  useEffect(() => {
    setHelloAvailable(isWindows)
  }, [])

  // 检查 HTTP API 服务状态
  useEffect(() => {
    const checkApiStatus = async () => {
      try {
        const status = await window.electronAPI.http.status()
        setHttpApiRunning(status.running)
        if (status.port) {
          setHttpApiPort(status.port)
        }
        if (status.mediaExportPath) {
          setHttpApiMediaExportPath(status.mediaExportPath)
        }
      } catch (e) {
        console.error('检查 API 状态失败:', e)
      }
    }
    checkApiStatus()
  }, [])

  useEffect(() => {
    loadConfig()
    loadAppVersion()
    return () => {
      Object.values(saveTimersRef.current).forEach((timer) => clearTimeout(timer))
    }
  }, [])

  useEffect(() => {
    const initialTab = (location.state as { initialTab?: SettingsTab } | null)?.initialTab
    if (!initialTab) return
    setActiveTab(initialTab)
  }, [location.state])

  useEffect(() => {
    if (!onClose) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const removeDb = window.electronAPI.key.onDbKeyStatus((payload: { message: string; level: number }) => {
      setDbKeyStatus(payload.message)
    })

    const removeImage = window.electronAPI.key.onImageKeyStatus((payload: { message: string, percent?: number }) => {
      let msg = payload.message;
      let pct = payload.percent;

      // 如果后端没有显式传 percent，则用正则从字符串中提取如 "(12.5%)"
      if (pct === undefined) {
        const match = msg.match(/\(([\d.]+)%\)/);
        if (match) {
          pct = parseFloat(match[1]);
          // 将百分比从文本中剥离，让 UI 更清爽
          msg = msg.replace(/\s*\([\d.]+%\)/, '');
        }
      }

      setImageKeyStatus(msg);
      if (pct !== undefined) {
        setImageKeyPercent(pct);
      } else if (msg.includes('启动多核') || msg.includes('定位') || msg.includes('准备')) {
        // 预热阶段
        setImageKeyPercent(0);
      }
    })
    return () => {
      removeDb?.()
      removeImage?.()
    }
  }, [])

  // 点击外部关闭自定义下拉框
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.custom-select')) {
        setFilterModeDropdownOpen(false)
        setPositionDropdownOpen(false)
        setCloseBehaviorDropdownOpen(false)
      }
    }
    if (filterModeDropdownOpen || positionDropdownOpen || closeBehaviorDropdownOpen) {
      document.addEventListener('click', handleClickOutside)
    }
    return () => {
      document.removeEventListener('click', handleClickOutside)
    }
  }, [closeBehaviorDropdownOpen, filterModeDropdownOpen, positionDropdownOpen])


  const loadConfig = async () => {
    try {
      const savedKey = await configService.getDecryptKey()
      const savedPath = await configService.getDbPath()
      const savedWxid = await configService.getMyWxid()
      const savedCachePath = await configService.getCachePath()

      const savedExportPath = await configService.getExportPath()
      const savedLogEnabled = await configService.getLogEnabled()
      const savedImageXorKey = await configService.getImageXorKey()
      const savedImageAesKey = await configService.getImageAesKey()
      const savedWhisperModelName = await configService.getWhisperModelName()
      const savedWhisperModelDir = await configService.getWhisperModelDir()
      const savedAutoTranscribe = await configService.getAutoTranscribeVoice()
      const savedTranscribeLanguages = await configService.getTranscribeLanguages()
      const savedNotificationEnabled = await configService.getNotificationEnabled()
      const savedNotificationPosition = await configService.getNotificationPosition()
      const savedNotificationFilterMode = await configService.getNotificationFilterMode()
      const savedNotificationFilterList = await configService.getNotificationFilterList()
      const savedMessagePushEnabled = await configService.getMessagePushEnabled()
      const savedWindowCloseBehavior = await configService.getWindowCloseBehavior()
      const savedQuoteLayout = await configService.getQuoteLayout()

      const savedAuthEnabled = await window.electronAPI.auth.verifyEnabled()
      const savedAuthUseHello = await configService.getAuthUseHello()
      const savedIsLockMode = await window.electronAPI.auth.isLockMode()

      const savedHttpApiToken = await configService.getHttpApiToken()
      if (savedHttpApiToken) setHttpApiToken(savedHttpApiToken)

      const savedApiPort = await configService.getHttpApiPort()
      if (savedApiPort) setHttpApiPort(savedApiPort)

      const savedApiHost = await configService.getHttpApiHost()
      if (savedApiHost) setHttpApiHost(savedApiHost)

      setAuthEnabled(savedAuthEnabled)
      setAuthUseHello(savedAuthUseHello)
      setIsLockMode(savedIsLockMode)

      if (savedPath) setDbPath(savedPath)
      if (savedWxid) setWxid(savedWxid)
      if (savedCachePath) setCachePath(savedCachePath)


      const wxidConfig = savedWxid ? await configService.getWxidConfig(savedWxid) : null
      const decryptKeyToUse = wxidConfig?.decryptKey ?? savedKey ?? ''
      const imageXorKeyToUse = typeof wxidConfig?.imageXorKey === 'number'
        ? wxidConfig.imageXorKey
        : savedImageXorKey
      const imageAesKeyToUse = wxidConfig?.imageAesKey ?? savedImageAesKey ?? ''

      setDecryptKey(decryptKeyToUse)
      if (typeof imageXorKeyToUse === 'number') {
        setImageXorKey(`0x${imageXorKeyToUse.toString(16).toUpperCase().padStart(2, '0')}`)
      } else {
        setImageXorKey('')
      }
      setImageAesKey(imageAesKeyToUse)
      setLogEnabled(savedLogEnabled)
      setAutoTranscribeVoice(savedAutoTranscribe)
      setTranscribeLanguages(savedTranscribeLanguages)

      setNotificationEnabled(savedNotificationEnabled)
      setNotificationPosition(savedNotificationPosition)
      setNotificationFilterMode(savedNotificationFilterMode)
      setNotificationFilterList(savedNotificationFilterList)
      setMessagePushEnabled(savedMessagePushEnabled)
      setWindowCloseBehavior(savedWindowCloseBehavior)
      setQuoteLayout(savedQuoteLayout)

      const savedExcludeWords = await configService.getWordCloudExcludeWords()
      setWordCloudExcludeWords(savedExcludeWords)
      setExcludeWordsInput(savedExcludeWords.join('\n'))

      const savedAnalyticsConsent = await configService.getAnalyticsConsent()
      setAnalyticsConsent(savedAnalyticsConsent ?? false)



      // 如果语言列表为空，保存默认值
      if (!savedTranscribeLanguages || savedTranscribeLanguages.length === 0) {
        const defaultLanguages = ['zh']
        setTranscribeLanguages(defaultLanguages)
        await configService.setTranscribeLanguages(defaultLanguages)
      }


      if (savedWhisperModelDir) setWhisperModelDir(savedWhisperModelDir)


    } catch (e: any) {
      console.error('加载配置失败:', e)
    }
  }



  const refreshWhisperStatus = async (modelDirValue = whisperModelDir) => {
    try {
      const result = await window.electronAPI.whisper?.getModelStatus()
      if (result?.success) {
        setWhisperModelStatus({
          exists: Boolean(result.exists),
          modelPath: result.modelPath,
          tokensPath: result.tokensPath
        })
      }
    } catch {
      setWhisperModelStatus(null)
    }
  }

  const loadAppVersion = async () => {
    try {
      const version = await window.electronAPI.app.getVersion()
      setAppVersion(version)
    } catch (e: any) {
      console.error('获取版本号失败:', e)
    }
  }

  // 监听下载进度
  useEffect(() => {
    const removeListener = window.electronAPI.app.onDownloadProgress?.((progress: any) => {
      setDownloadProgress(progress)
    })
    return () => removeListener?.()
  }, [])

  useEffect(() => {
    const removeListener = window.electronAPI.whisper?.onDownloadProgress?.((payload: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number; speed?: number }) => {
      setWhisperProgressData({
        downloaded: payload.downloadedBytes,
        total: payload.totalBytes || 0,
        speed: payload.speed || 0
      })
      if (typeof payload.percent === 'number') {
        setWhisperDownloadProgress(payload.percent)
      }
    })
    return () => removeListener?.()
  }, [])

  useEffect(() => {
    void refreshWhisperStatus(whisperModelDir)
  }, [whisperModelDir])

  const handleCheckUpdate = async () => {
    if (isCheckingUpdate) return
    setIsCheckingUpdate(true)
    setUpdateInfo(null)
    try {
      const result = await window.electronAPI.app.checkForUpdates()
      if (result.hasUpdate) {
        setUpdateInfo(result)
        setShowUpdateDialog(true)
        showMessage(`发现新版：${result.version}`, true)
      } else {
        showMessage('当前已是最新版', true)
      }
    } catch (e: any) {
      showMessage(`检查更新失败: ${e}`, false)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  const handleUpdateNow = async () => {
    setShowUpdateDialog(false)

    setIsDownloading(true)
    setDownloadProgress({ percent: 0 })
    try {
      showMessage('正在下载更新...', true)
      await window.electronAPI.app.downloadAndInstall()
    } catch (e: any) {
      showMessage(`更新失败: ${e}`, false)
      setIsDownloading(false)
    }
  }

  const handleIgnoreUpdate = async () => {
    if (!updateInfo || !updateInfo.version) return

    try {
      await window.electronAPI.app.ignoreUpdate(updateInfo.version)
      setShowUpdateDialog(false)
      setUpdateInfo(null)
      showMessage(`已忽略版本 ${updateInfo.version}`, true)
    } catch (e: any) {
      showMessage(`操作失败: ${e}`, false)
    }
  }



  const showMessage = (text: string, success: boolean) => {
    setMessage({ text, success })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleClose = () => {
    if (!onClose) return
    setIsClosing(true)
    setTimeout(() => {
      onClose()
    }, 200)
  }

  type WxidKeys = {
    decryptKey: string
    imageXorKey: number | null
    imageAesKey: string
  }

  const formatImageXorKey = (value: number) => `0x${value.toString(16).toUpperCase().padStart(2, '0')}`

  const parseImageXorKey = (value: string) => {
    if (!value) return null
    const parsed = parseInt(value.replace(/^0x/i, ''), 16)
    return Number.isNaN(parsed) ? null : parsed
  }

  const buildKeysFromState = (): WxidKeys => ({
    decryptKey: decryptKey || '',
    imageXorKey: parseImageXorKey(imageXorKey),
    imageAesKey: imageAesKey || ''
  })

  const buildKeysFromInputs = (overrides?: { decryptKey?: string; imageXorKey?: string; imageAesKey?: string }): WxidKeys => ({
    decryptKey: overrides?.decryptKey ?? decryptKey ?? '',
    imageXorKey: parseImageXorKey(overrides?.imageXorKey ?? imageXorKey),
    imageAesKey: overrides?.imageAesKey ?? imageAesKey ?? ''
  })

  const buildKeysFromConfig = (wxidConfig: configService.WxidConfig | null): WxidKeys => ({
    decryptKey: wxidConfig?.decryptKey || '',
    imageXorKey: typeof wxidConfig?.imageXorKey === 'number' ? wxidConfig.imageXorKey : null,
    imageAesKey: wxidConfig?.imageAesKey || ''
  })

  const applyKeysToState = (keys: WxidKeys) => {
    setDecryptKey(keys.decryptKey)
    if (typeof keys.imageXorKey === 'number') {
      setImageXorKey(formatImageXorKey(keys.imageXorKey))
    } else {
      setImageXorKey('')
    }
    setImageAesKey(keys.imageAesKey)
  }

  const syncKeysToConfig = async (keys: WxidKeys) => {
    await configService.setDecryptKey(keys.decryptKey)
    await configService.setImageXorKey(typeof keys.imageXorKey === 'number' ? keys.imageXorKey : 0)
    await configService.setImageAesKey(keys.imageAesKey)
  }

  const applyWxidSelection = async (
    selectedWxid: string,
    options?: { preferCurrentKeys?: boolean; showToast?: boolean; toastText?: string; keysOverride?: WxidKeys }
  ) => {
    if (!selectedWxid) return

    const currentWxid = wxid
    const isSameWxid = currentWxid === selectedWxid
    if (currentWxid && currentWxid !== selectedWxid) {
      const currentKeys = buildKeysFromState()
      await configService.setWxidConfig(currentWxid, {
        decryptKey: currentKeys.decryptKey,
        imageXorKey: typeof currentKeys.imageXorKey === 'number' ? currentKeys.imageXorKey : 0,
        imageAesKey: currentKeys.imageAesKey
      })
    }

    const preferCurrentKeys = options?.preferCurrentKeys ?? false
    const keys = options?.keysOverride ?? (preferCurrentKeys
      ? buildKeysFromState()
      : buildKeysFromConfig(await configService.getWxidConfig(selectedWxid)))

    setWxid(selectedWxid)
    applyKeysToState(keys)
    await configService.setMyWxid(selectedWxid)
    await syncKeysToConfig(keys)
    await configService.setWxidConfig(selectedWxid, {
      decryptKey: keys.decryptKey,
      imageXorKey: typeof keys.imageXorKey === 'number' ? keys.imageXorKey : 0,
      imageAesKey: keys.imageAesKey
    })
    setShowWxidSelect(false)
    if (isDbConnected) {
      try {
        await window.electronAPI.chat.close()
        const result = await window.electronAPI.chat.connect()
        setDbConnected(result.success, dbPath || undefined)
        if (!result.success && result.error) {
          showMessage(result.error, false)
        }
      } catch (e: any) {
        showMessage(`切换账号后重新连接失败: ${e}`, false)
        setDbConnected(false)
      }
    }
    if (!isSameWxid) {
      clearAnalyticsStoreCache()
      resetChatStore()
      window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: selectedWxid } }))
    }
    if (options?.showToast ?? true) {
      showMessage(options?.toastText || `已选择账号：${selectedWxid}`, true)
    }
  }

  const validatePath = (path: string): string | null => {
    if (!path) return null
    if (/[\u4e00-\u9fa5]/.test(path)) {
      return '路径包含中文字符，请迁移至全英文目录'
    }
    return null
  }

  const handleAutoDetectPath = async () => {
    if (isDetectingPath) return
    setIsDetectingPath(true)
    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        const validationError = validatePath(result.path)
        if (validationError) {
          showMessage(validationError, false)
        } else {
          setDbPath(result.path)
          await configService.setDbPath(result.path)
          showMessage(`自动检测成功：${result.path}`, true)

          const wxids = await window.electronAPI.dbPath.scanWxids(result.path)
          setWxidOptions(wxids)
          if (wxids.length === 1) {
            await applyWxidSelection(wxids[0].wxid, {
              toastText: `已检测到账号：${wxids[0].wxid}`
            })
          } else if (wxids.length > 1) {
            setShowWxidSelect(true)
          }
        }
      } else {
        showMessage(result.error || '未能自动检测到数据库目录', false)
      }
    } catch (e: any) {
      showMessage(`自动检测失败: ${e}`, false)
    } finally {
      setIsDetectingPath(false)
    }
  }

  const handleSelectDbPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择微信数据库根目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0]
        const validationError = validatePath(selectedPath)
        if (validationError) {
          showMessage(validationError, false)
        } else {
          setDbPath(selectedPath)
          await configService.setDbPath(selectedPath)
          showMessage('已选择数据库目录', true)
        }
      }
    } catch (e: any) {
      showMessage('选择目录失败', false)
    }
  }

  const handleScanWxid = async (
    silent = false,
    options?: { preferCurrentKeys?: boolean; showDialog?: boolean; keysOverride?: WxidKeys }
  ) => {
    if (!dbPath) {
      if (!silent) showMessage('请先选择数据库目录', false)
      return
    }
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setWxidOptions(wxids)
      const allowDialog = options?.showDialog ?? !silent
      if (wxids.length === 1) {
        await applyWxidSelection(wxids[0].wxid, {
          preferCurrentKeys: options?.preferCurrentKeys ?? false,
          showToast: !silent,
          toastText: `已检测到账号：${wxids[0].wxid}`,
          keysOverride: options?.keysOverride
        })
      } else if (wxids.length > 1 && allowDialog) {
        setShowWxidSelect(true)
      } else {
        if (!silent) showMessage('未检测到账号目录，请检查路径', false)
      }
    } catch (e: any) {
      if (!silent) showMessage(`扫描失败: ${e}`, false)
    }
  }

  const handleSelectWxid = async (selectedWxid: string) => {
    await applyWxidSelection(selectedWxid)
  }


  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择缓存目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0]
        setCachePath(selectedPath)
        await configService.setCachePath(selectedPath)
        showMessage('已选择缓存目录', true)
      }
    } catch (e: any) {
      showMessage('选择目录失败', false)
    }
  }



  const handleSelectWhisperModelDir = async () => {
    try {
      const result = await dialog.openFile({ title: '选择 Whisper 模型下载目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        const dir = result.filePaths[0]
        setWhisperModelDir(dir)
        await configService.setWhisperModelDir(dir)
        showMessage('已选择 Whisper 模型目录', true)
      }
    } catch (e: any) {
      showMessage('选择目录失败', false)
    }
  }

  const handleWhisperModelChange = async (value: string) => {
    setWhisperModelName(value)
    setWhisperDownloadProgress(0)
    await configService.setWhisperModelName(value)
  }

  const handleDownloadWhisperModel = async () => {
    if (isWhisperDownloading) return
    setIsWhisperDownloading(true)
    setWhisperDownloadProgress(0)
    try {
      const result = await window.electronAPI.whisper.downloadModel()
      if (result.success) {
        setWhisperDownloadProgress(100)
        showMessage('SenseVoiceSmall 模型下载完成', true)
        await refreshWhisperStatus(whisperModelDir)
      } else {
        showMessage(result.error || '模型下载失败', false)
      }
    } catch (e: any) {
      showMessage(`模型下载失败: ${e}`, false)
    } finally {
      setIsWhisperDownloading(false)
    }
  }

  const handleResetWhisperModelDir = async () => {
    setWhisperModelDir('')
    await configService.setWhisperModelDir('')
  }

  const handleAutoGetDbKey = async () => {
    if (isFetchingDbKey) return
    setIsFetchingDbKey(true)
    setIsManualStartPrompt(false)
    setDbKeyStatus('正在连接微信进程...')
    try {
      const result = await window.electronAPI.key.autoGetDbKey()
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setDbKeyStatus('密钥获取成功')
        showMessage('已自动获取解密密钥', true)
        await syncCurrentKeys({ decryptKey: result.key, wxid })
        const keysOverride = buildKeysFromInputs({ decryptKey: result.key })
        await handleScanWxid(true, { preferCurrentKeys: true, showDialog: false, keysOverride })
      } else {
        if (result.error?.includes('未找到微信安装路径') || result.error?.includes('启动微信失败')) {
          setIsManualStartPrompt(true)
          setDbKeyStatus('需要手动启动微信')
        } else {
          showMessage(result.error || '自动获取密钥失败', false)
        }
      }
    } catch (e: any) {
      showMessage(`自动获取密钥失败: ${e}`, false)
    } finally {
      setIsFetchingDbKey(false)
    }
  }

  const handleManualConfirm = async () => {
    setIsManualStartPrompt(false)
    handleAutoGetDbKey()
  }

  // Debounce config writes to avoid excessive disk IO
  const scheduleConfigSave = (key: string, task: () => Promise<void> | void, delay = 300) => {
    const timers = saveTimersRef.current
    if (timers[key]) {
      clearTimeout(timers[key])
    }
    timers[key] = setTimeout(() => {
      Promise.resolve(task()).catch((e) => {
        console.error('保存配置失败:', e)
      })
    }, delay)
  }

  const syncCurrentKeys = async (options?: { decryptKey?: string; imageXorKey?: string; imageAesKey?: string; wxid?: string }) => {
    const keys = buildKeysFromInputs(options)
    await syncKeysToConfig(keys)
    const wxidToUse = options?.wxid ?? wxid
    if (wxidToUse) {
      await configService.setWxidConfig(wxidToUse, {
        decryptKey: keys.decryptKey,
        imageXorKey: typeof keys.imageXorKey === 'number' ? keys.imageXorKey : 0,
        imageAesKey: keys.imageAesKey
      })
    }
  }

  const handleAutoGetImageKey = async () => {
    if (isFetchingImageKey) return;
    if (!dbPath) { showMessage('请先选择数据库目录', false); return; }
    setIsFetchingImageKey(true);
    setImageKeyPercent(0)
    setImageKeyStatus('正在初始化...');
    setImageKeyProgress(0);

    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath;
      const result = await window.electronAPI.key.autoGetImageKey(accountPath, wxid)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        setImageKeyStatus('已获取图片密钥')
        showMessage('已自动获取图片密钥', true)
        const newXorKey = typeof result.xorKey === 'number' ? result.xorKey : 0
        const newAesKey = result.aesKey
        await configService.setImageXorKey(newXorKey)
        await configService.setImageAesKey(newAesKey)
        if (wxid) await configService.setWxidConfig(wxid, { decryptKey, imageXorKey: newXorKey, imageAesKey: newAesKey })
      } else {
        showMessage(result.error || '自动获取图片密钥失败', false)
      }
    } catch (e: any) {
      showMessage(`自动获取图片密钥失败: ${e}`, false)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const handleScanImageKeyFromMemory = async () => {
    if (isFetchingImageKey) return;
    if (!dbPath) { showMessage('请先选择数据库目录', false); return; }
    setIsFetchingImageKey(true);
    setImageKeyPercent(0)
    setImageKeyStatus('正在扫描内存...');

    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath;
      const result = await window.electronAPI.key.scanImageKeyFromMemory(accountPath)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        setImageKeyStatus('内存扫描成功，已获取图片密钥')
        showMessage('内存扫描成功，已获取图片密钥', true)
        const newXorKey = typeof result.xorKey === 'number' ? result.xorKey : 0
        const newAesKey = result.aesKey
        await configService.setImageXorKey(newXorKey)
        await configService.setImageAesKey(newAesKey)
        if (wxid) await configService.setWxidConfig(wxid, { decryptKey, imageXorKey: newXorKey, imageAesKey: newAesKey })
      } else {
        showMessage(result.error || '内存扫描获取图片密钥失败', false)
      }
    } catch (e: any) {
      showMessage(`内存扫描失败: ${e}`, false)
    } finally {
      setIsFetchingImageKey(false)
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
    } catch (e: any) {
      showMessage(`连接测试失败: ${e}`, false)
    } finally {
      setIsTesting(false)
    }
  }

  // Removed manual save config function


  const handleClearConfig = async () => {
    const confirmed = window.confirm('确定要清除当前配置吗？清除后需要重新完成首次配置？')
    if (!confirmed) return
    setIsLoadingState(true)
    setLoading(true, '正在清除配置...')
    try {
      await window.electronAPI.wcdb.close()
      await configService.clearConfig()
      reset()
      setDecryptKey('')
      setImageXorKey('')
      setImageAesKey('')
      setDbPath('')
      setWxid('')
      setCachePath('')
      setLogEnabled(false)
      setAutoTranscribeVoice(false)
      setTranscribeLanguages(['zh'])
      setWhisperModelDir('')
      setWhisperModelStatus(null)
      setWhisperDownloadProgress(0)
      setIsWhisperDownloading(false)
      setDbConnected(false)
      await window.electronAPI.window.openOnboardingWindow()
    } catch (e: any) {
      showMessage(`清除配置失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  const handleOpenLog = async () => {
    try {
      const logPath = await window.electronAPI.log.getPath()
      await window.electronAPI.shell.openPath(logPath)
    } catch (e: any) {
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
    } catch (e: any) {
      showMessage(`复制日志失败: ${e}`, false)
    }
  }

  const handleClearLog = async () => {
    const confirmed = window.confirm('确定清空 wcdb.log 吗？')
    if (!confirmed) return
    try {
      const result = await window.electronAPI.log.clear()
      if (!result.success) {
        showMessage(result.error || '清空日志失败', false)
        return
      }
      showMessage('日志已清空', true)
    } catch (e: any) {
      showMessage(`清空日志失败: ${e}`, false)
    }
  }

  const handleClearAnalyticsCache = async () => {
    if (isClearingCache) return
    setIsClearingAnalyticsCache(true)
    try {
      const result = await window.electronAPI.cache.clearAnalytics()
      if (result.success) {
        clearAnalyticsStoreCache()
        showMessage('已清除分析缓存', true)
      } else {
        showMessage(`清除分析缓存失败: ${result.error || '未知错误'}`, false)
      }
    } catch (e: any) {
      showMessage(`清除分析缓存失败: ${e}`, false)
    } finally {
      setIsClearingAnalyticsCache(false)
    }
  }

  const handleClearImageCache = async () => {
    if (isClearingCache) return
    setIsClearingImageCache(true)
    try {
      const result = await window.electronAPI.cache.clearImages()
      if (result.success) {
        showMessage('已清除图片缓存', true)
      } else {
        showMessage(`清除图片缓存失败: ${result.error || '未知错误'}`, false)
      }
    } catch (e: any) {
      showMessage(`清除图片缓存失败: ${e}`, false)
    } finally {
      setIsClearingImageCache(false)
    }
  }

  const handleClearAllCache = async () => {
    if (isClearingCache) return
    setIsClearingAllCache(true)
    try {
      const result = await window.electronAPI.cache.clearAll()
      if (result.success) {
        clearAnalyticsStoreCache()
        showMessage('已清除所有缓存', true)
      } else {
        showMessage(`清除所有缓存失败: ${result.error || '未知错误'}`, false)
      }
    } catch (e: any) {
      showMessage(`清除所有缓存失败: ${e}`, false)
    } finally {
      setIsClearingAllCache(false)
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
        <button className={`mode-btn ${themeMode === 'system' ? 'active' : ''}`} onClick={() => setThemeMode('system')}>
          <Monitor size={16} /> 跟随系统
        </button>
      </div>
      <div className="theme-grid">
        {themes.map((theme) => (
          <div key={theme.id} className={`theme-card ${currentTheme === theme.id ? 'active' : ''}`} onClick={() => setTheme(theme.id)}>
            <div className="theme-preview" style={{
              background: effectiveMode === 'dark'
                ? (theme.id === 'blossom-dream' ? 'linear-gradient(150deg, #151316 0%, #1A1620 50%, #131018 100%)'
                  : theme.id === 'geist' ? 'linear-gradient(135deg, #1a1a1a 0%, #222222 100%)'
                  : 'linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%)')
                : (theme.id === 'blossom-dream' ? `linear-gradient(150deg, ${theme.bgColor} 0%, #F8F2F8 45%, #F2F6FB 100%)`
                  : theme.id === 'geist' ? 'linear-gradient(135deg, #ffffff 0%, #f0f0f0 100%)'
                  : `linear-gradient(135deg, ${theme.bgColor} 0%, ${theme.bgColor}dd 100%)`)
            }}>
              <div className="theme-accent" style={{
                background: theme.accentColor
                  ? `linear-gradient(135deg, ${theme.primaryColor} 0%, ${theme.accentColor} 100%)`
                  : theme.primaryColor
              }} />
            </div>
            <div className="theme-info">
              <span className="theme-name">{theme.name}</span>
              <span className="theme-desc">{theme.description}</span>
            </div>
            {currentTheme === theme.id && <div className="theme-check"><Check size={14} /></div>}
          </div>
        ))}
      </div>

      <div className="form-group quote-layout-group">
        <label>引用消息样式</label>
        <span className="form-hint">选择聊天中引用消息与正文的上下顺序，下方预览会同步展示布局差异。</span>
        <div className="quote-layout-picker" role="radiogroup" aria-label="引用样式选择">
          {[
            {
              value: 'quote-top' as const,
              label: '引用在上',
              description: '更接近当前 WeFlow 风格',
              successMessage: '已切换为引用在上样式'
            },
            {
              value: 'quote-bottom' as const,
              label: '正文在上',
              description: '更接近微信 / 密语风格',
              successMessage: '已切换为正文在上样式'
            }
          ].map(option => {
            const selected = quoteLayout === option.value
            const isQuoteBottom = option.value === 'quote-bottom'

            return (
              <button
                key={option.value}
                type="button"
                className={`quote-layout-card ${selected ? 'active' : ''}`}
                onClick={async () => {
                  if (selected) return
                  setQuoteLayout(option.value)
                  await configService.setQuoteLayout(option.value)
                  showMessage(option.successMessage, true)
                }}
                role="radio"
                aria-checked={selected}
              >
                <span className={`quote-layout-card-check ${selected ? 'active' : ''}`} aria-hidden="true" />
                <div className="quote-layout-preview-shell">
                  <div className="quote-layout-preview-chat">
                    <div className="message-bubble sent">
                      <div className={`bubble-content ${isQuoteBottom ? 'quote-layout-bottom' : 'quote-layout-top'}`}>
                        {isQuoteBottom ? (
                          <>
                            <div className="message-text">拍得真不错!</div>
                            <div className="quoted-message">
                              <span className="quoted-sender">张三</span>
                              <span className="quoted-text">那天去爬山的照片...</span>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="quoted-message">
                              <span className="quoted-sender">张三</span>
                              <span className="quoted-text">那天去爬山的照片...</span>
                            </div>
                            <div className="message-text">拍得真不错!</div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="quote-layout-card-footer">
                  <div className="quote-layout-card-title-group">
                    <span className="quote-layout-card-title">{option.label}</span>
                    <span className="quote-layout-card-desc">{option.description}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="divider" />

      <div className="form-group">
        <label>关闭主窗口时</label>
        <span className="form-hint">设置点击关闭按钮后的默认行为；选择“每次询问”时会弹出关闭确认。</span>
        <div className="custom-select">
          <div
            className={`custom-select-trigger ${closeBehaviorDropdownOpen ? 'open' : ''}`}
            onClick={() => setCloseBehaviorDropdownOpen(!closeBehaviorDropdownOpen)}
          >
            <span className="custom-select-value">
              {windowCloseBehavior === 'tray'
                ? '最小化到系统托盘'
                : windowCloseBehavior === 'quit'
                  ? '完全关闭'
                  : '每次询问'}
            </span>
            <ChevronDown size={14} className={`custom-select-arrow ${closeBehaviorDropdownOpen ? 'rotate' : ''}`} />
          </div>
          <div className={`custom-select-dropdown ${closeBehaviorDropdownOpen ? 'open' : ''}`}>
            {[
              {
                value: 'ask' as const,
                label: '每次询问',
                successMessage: '已恢复关闭确认弹窗'
              },
              {
                value: 'tray' as const,
                label: '最小化到系统托盘',
                successMessage: '关闭按钮已改为最小化到托盘'
              },
              {
                value: 'quit' as const,
                label: '完全关闭',
                successMessage: '关闭按钮已改为完全关闭'
              }
            ].map(option => (
              <div
                key={option.value}
                className={`custom-select-option ${windowCloseBehavior === option.value ? 'selected' : ''}`}
                onClick={async () => {
                  setWindowCloseBehavior(option.value)
                  setCloseBehaviorDropdownOpen(false)
                  await configService.setWindowCloseBehavior(option.value)
                  showMessage(option.successMessage, true)
                }}
              >
                {option.label}
                {windowCloseBehavior === option.value && <Check size={14} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )

  const renderNotificationTab = () => {
    const { sessions } = useChatStore.getState()

    // 获取已过滤会话的信息
    const getSessionInfo = (username: string) => {
      const session = sessions.find(s => s.username === username)
      return {
        displayName: session?.displayName || username,
        avatarUrl: session?.avatarUrl || ''
      }
    }

    // 添加会话到过滤列表
    const handleAddToFilterList = async (username: string) => {
      if (notificationFilterList.includes(username)) return
      const newList = [...notificationFilterList, username]
      setNotificationFilterList(newList)
      await configService.setNotificationFilterList(newList)
      showMessage('已添加到过滤列表', true)
    }

    // 从过滤列表移除会话
    const handleRemoveFromFilterList = async (username: string) => {
      const newList = notificationFilterList.filter(u => u !== username)
      setNotificationFilterList(newList)
      await configService.setNotificationFilterList(newList)
      showMessage('已从过滤列表移除', true)
    }

    // 过滤掉已在列表中的会话，并根据搜索关键字过滤
    const availableSessions = sessions.filter(s => {
      if (notificationFilterList.includes(s.username)) return false
      if (filterSearchKeyword) {
        const keyword = filterSearchKeyword.toLowerCase()
        const displayName = (s.displayName || '').toLowerCase()
        const username = s.username.toLowerCase()
        return displayName.includes(keyword) || username.includes(keyword)
      }
      return true
    })

    return (
      <div className="tab-content">
        <div className="form-group">
          <label>新消息通知</label>
          <span className="form-hint">开启后，收到新消息时将显示桌面弹窗通知</span>
          <div className="log-toggle-line">
            <span className="log-status">{notificationEnabled ? '已开启' : '已关闭'}</span>
            <label className="switch" htmlFor="notification-enabled-toggle">
              <input
                id="notification-enabled-toggle"
                className="switch-input"
                type="checkbox"
                checked={notificationEnabled}
                onChange={async (e) => {
                  const val = e.target.checked
                  setNotificationEnabled(val)
                  await configService.setNotificationEnabled(val)
                  showMessage(val ? '已开启通知' : '已关闭通知', true)
                }}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        <div className="form-group">
          <label>通知显示位置</label>
          <span className="form-hint">选择通知弹窗在屏幕上的显示位置</span>
          {isWayland && (
              <span className="form-hint" style={{ color: '#ff4d4f', marginTop: '4px', display: 'block' }}>
              ⚠️ 注意：Wayland 环境下该配置可能无效！
            </span>
          )}
          <div className="custom-select">
            <div
              className={`custom-select-trigger ${positionDropdownOpen ? 'open' : ''}`}
              onClick={() => setPositionDropdownOpen(!positionDropdownOpen)}
            >
              <span className="custom-select-value">
                {notificationPosition === 'top-right' ? '右上角' :
                  notificationPosition === 'bottom-right' ? '右下角' :
                    notificationPosition === 'top-left' ? '左上角' :
                      notificationPosition === 'top-center' ? '中间上方' : '左下角'}
              </span>
              <ChevronDown size={14} className={`custom-select-arrow ${positionDropdownOpen ? 'rotate' : ''}`} />
            </div>
            <div className={`custom-select-dropdown ${positionDropdownOpen ? 'open' : ''}`}>
              {[
                { value: 'top-center', label: '中间上方' },
                { value: 'top-right', label: '右上角' },
                { value: 'bottom-right', label: '右下角' },
                { value: 'top-left', label: '左上角' },
                { value: 'bottom-left', label: '左下角' }
              ].map(option => (
                <div
                  key={option.value}
                  className={`custom-select-option ${notificationPosition === option.value ? 'selected' : ''}`}
                  onClick={async () => {
                    const val = option.value as 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center'
                    setNotificationPosition(val)
                    setPositionDropdownOpen(false)
                    await configService.setNotificationPosition(val)
                    showMessage('通知位置已更新', true)
                  }}
                >
                  {option.label}
                  {notificationPosition === option.value && <Check size={14} />}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="form-group">
          <label>会话过滤</label>
          <span className="form-hint">选择只接收特定会话的通知，或屏蔽特定会话的通知</span>
          <div className="custom-select">
            <div
              className={`custom-select-trigger ${filterModeDropdownOpen ? 'open' : ''}`}
              onClick={() => setFilterModeDropdownOpen(!filterModeDropdownOpen)}
            >
              <span className="custom-select-value">
                {notificationFilterMode === 'all' ? '接收所有通知' :
                  notificationFilterMode === 'whitelist' ? '仅接收白名单' : '屏蔽黑名单'}
              </span>
              <ChevronDown size={14} className={`custom-select-arrow ${filterModeDropdownOpen ? 'rotate' : ''}`} />
            </div>
            <div className={`custom-select-dropdown ${filterModeDropdownOpen ? 'open' : ''}`}>
              {[
                { value: 'all', label: '接收所有通知' },
                { value: 'whitelist', label: '仅接收白名单' },
                { value: 'blacklist', label: '屏蔽黑名单' }
              ].map(option => (
                <div
                  key={option.value}
                  className={`custom-select-option ${notificationFilterMode === option.value ? 'selected' : ''}`}
                  onClick={async () => {
                    const val = option.value as 'all' | 'whitelist' | 'blacklist'
                    setNotificationFilterMode(val)
                    setFilterModeDropdownOpen(false)
                    await configService.setNotificationFilterMode(val)
                    showMessage(
                      val === 'all' ? '已设为接收所有通知' :
                        val === 'whitelist' ? '已设为仅接收白名单通知' : '已设为屏蔽黑名单通知',
                      true
                    )
                  }}
                >
                  {option.label}
                  {notificationFilterMode === option.value && <Check size={14} />}
                </div>
              ))}
            </div>
          </div>
        </div>

        {notificationFilterMode !== 'all' && (
          <div className="form-group">
            <label>{notificationFilterMode === 'whitelist' ? '白名单会话' : '黑名单会话'}</label>
            <span className="form-hint">
              {notificationFilterMode === 'whitelist'
                ? '点击左侧会话添加到白名单，点击右侧会话从白名单移除'
                : '点击左侧会话添加到黑名单，点击右侧会话从黑名单移除'}
            </span>

            <div className="notification-filter-container">
              {/* 可选会话列表 */}
              <div className="filter-panel">
                <div className="filter-panel-header">
                  <span>可选会话</span>
                  <div className="filter-search-box">
                    <Search size={14} />
                    <input
                      type="text"
                      placeholder="搜索会话..."
                      value={filterSearchKeyword}
                      onChange={(e) => setFilterSearchKeyword(e.target.value)}
                    />
                  </div>
                </div>
                <div className="filter-panel-list">
                  {availableSessions.length > 0 ? (
                    availableSessions.map(session => (
                      <div
                        key={session.username}
                        className="filter-panel-item"
                        onClick={() => handleAddToFilterList(session.username)}
                      >
                        <Avatar
                          src={session.avatarUrl}
                          name={session.displayName || session.username}
                          size={28}
                        />
                        <span className="filter-item-name">{session.displayName || session.username}</span>
                        <span className="filter-item-action">+</span>
                      </div>
                    ))
                  ) : (
                    <div className="filter-panel-empty">
                      {filterSearchKeyword ? '没有匹配的会话' : '暂无可添加的会话'}
                    </div>
                  )}
                </div>
              </div>

              {/* 已选会话列表 */}
              <div className="filter-panel">
                <div className="filter-panel-header">
                  <span>{notificationFilterMode === 'whitelist' ? '白名单' : '黑名单'}</span>
                  {notificationFilterList.length > 0 && (
                    <span className="filter-panel-count">{notificationFilterList.length}</span>
                  )}
                </div>
                <div className="filter-panel-list">
                  {notificationFilterList.length > 0 ? (
                    notificationFilterList.map(username => {
                      const info = getSessionInfo(username)
                      return (
                        <div
                          key={username}
                          className="filter-panel-item selected"
                          onClick={() => handleRemoveFromFilterList(username)}
                        >
                          <Avatar
                            src={info.avatarUrl}
                            name={info.displayName}
                            size={28}
                          />
                          <span className="filter-item-name">{info.displayName}</span>
                          <span className="filter-item-action">×</span>
                        </div>
                      )
                    })
                  ) : (
                    <div className="filter-panel-empty">尚未添加任何会话</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderDatabaseTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>解密密钥</label>
        <span className="form-hint">64位十六进制密钥</span>
        <div className="input-with-toggle">
          <input
            type={showDecryptKey ? 'text' : 'password'}
            placeholder="例如: a1b2c3d4e5f6..."
            value={decryptKey}
            onChange={(e) => {
              const value = e.target.value
              setDecryptKey(value)
              if (value && value.length === 64) {
                scheduleConfigSave('keys', () => syncCurrentKeys({ decryptKey: value, wxid }))
                // showMessage('解密密钥已保存', true)
              }
            }}
          />
          <button type="button" className="toggle-visibility" onClick={() => setShowDecryptKey(!showDecryptKey)}>
            {showDecryptKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {isManualStartPrompt ? (
          <div className="manual-prompt">
            <p className="prompt-text">未能自动启动微信，请手动启动并登录后点击下方确认</p>
            <button className="btn btn-primary btn-sm" onClick={handleManualConfirm}>
              我已启动微信，继续检测
            </button>
          </div>
        ) : (
          <button className="btn btn-secondary btn-sm" onClick={handleAutoGetDbKey} disabled={isFetchingDbKey}>
            <Plug size={14} /> {isFetchingDbKey ? '获取中...' : '自动获取密钥'}
          </button>
        )}
        {dbKeyStatus && <div className="form-hint status-text">{dbKeyStatus}</div>}
      </div>

      <div className="form-group">
        <label>数据库根目录</label>
        <span className="form-hint">xwechat_files 目录</span>
        <input
          type="text"
          placeholder={dbPathPlaceholder}
          value={dbPath}
          onChange={(e) => {
            const value = e.target.value
            setDbPath(value)
            scheduleConfigSave('dbPath', async () => {
              if (value) {
                await configService.setDbPath(value)
              }
            })
          }}
        />
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
        <div className="wxid-input-wrapper">
          <input
            type="text"
            placeholder="例如: wxid_xxxxxx"
            value={wxid}
            onChange={(e) => {
              const value = e.target.value
              const previousWxid = wxid
              setWxid(value)
              scheduleConfigSave('wxid', async () => {
                if (previousWxid && previousWxid !== value) {
                  const currentKeys = buildKeysFromState()
                  await configService.setWxidConfig(previousWxid, {
                    decryptKey: currentKeys.decryptKey,
                    imageXorKey: typeof currentKeys.imageXorKey === 'number' ? currentKeys.imageXorKey : 0,
                    imageAesKey: currentKeys.imageAesKey
                  })
                }
                if (value) {
                  await configService.setMyWxid(value)
                  await syncCurrentKeys({ wxid: value }) // Sync keys to the new wxid entry
                }

                if (value && previousWxid !== value) {
                  if (isDbConnected) {
                    try {
                      await window.electronAPI.chat.close()
                      const result = await window.electronAPI.chat.connect()
                      setDbConnected(result.success, dbPath || undefined)
                      if (!result.success && result.error) {
                        showMessage(result.error, false)
                      }
                    } catch (e: any) {
                      showMessage(`切换账号后重新连接失败: ${e}`, false)
                      setDbConnected(false)
                    }
                  }
                  clearAnalyticsStoreCache()
                  resetChatStore()
                  window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: value } }))
                }
              })
            }}
          />
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => handleScanWxid()}><Search size={14} /> 扫描 wxid</button>
      </div>

      <div className="form-group">
        <label>图片 XOR 密钥 <span className="optional">(可选)</span></label>
        <span className="form-hint">用于解密图片缓存</span>
        <input
          type="text"
          placeholder="例如: 0xA4"
          value={imageXorKey}
          onChange={(e) => {
            const value = e.target.value
            setImageXorKey(value)
            const parsed = parseImageXorKey(value)
            if (value === '' || parsed !== null) {
              scheduleConfigSave('keys', () => syncCurrentKeys({ imageXorKey: value, wxid }))
            }
          }}
        />
      </div>

      <div className="form-group">
        <label>图片 AES 密钥 <span className="optional">(可选)</span></label>
        <span className="form-hint">16 位密钥</span>
        <input
          type="text"
          placeholder="16 位 AES 密钥"
          value={imageAesKey}
          onChange={(e) => {
            const value = e.target.value
            setImageAesKey(value)
            scheduleConfigSave('keys', () => syncCurrentKeys({ imageAesKey: value, wxid }))
          }}
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          <button className="btn btn-primary btn-sm" onClick={handleAutoGetImageKey} disabled={isFetchingImageKey} title="从本地缓存快速计算">
            <Plug size={14} /> {isFetchingImageKey ? '获取中...' : '缓存计算（推荐）'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleScanImageKeyFromMemory} disabled={isFetchingImageKey} title="扫描微信进程内存">
            {isFetchingImageKey ? '扫描中...' : '内存扫描'}
          </button>
        </div>
        {isFetchingImageKey ? (
          <div className="brute-force-progress">
            <div className="status-header">
              <span className="status-text">{imageKeyStatus || '正在启动...'}</span>
            </div>
          </div>
        ) : (
          imageKeyStatus && <div className="form-hint status-text" style={{ marginTop: '8px' }}>{imageKeyStatus}</div>
        )}
        <span className="form-hint">优先推荐缓存计算方案。若图片无法解密，可使用内存扫描（需微信运行并打开 2-3 张图片大图）</span>
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
          <button className="btn btn-secondary" onClick={handleClearLog}>
            <Trash2 size={16} /> 清空日志
          </button>
        </div>
      </div>
    </div>
  )
  const resolvedWhisperModelPath = whisperModelDir || whisperModelStatus?.modelPath || ''

  const renderModelsTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>模型管理</label>
        <span className="form-hint">管理语音识别模型</span>
      </div>

      <div className="form-group">
        <label>语音识别模型 (Whisper)</label>
        <span className="form-hint">用于语音消息转文字功能</span>

        <div className="setting-control vertical has-border">
          <div className="model-status-card">
            <div className="model-info">
              <div className="model-name-row">
                <div className="model-name">SenseVoiceSmall</div>
                <span className="model-size">245 MB</span>
              </div>
              <div className="model-meta">
                {whisperModelStatus?.exists ? (
                  <span className="status-indicator success"><Check size={14} /> 已安装</span>
                ) : (
                  <span className="status-indicator warning">未安装</span>
                )}
                {resolvedWhisperModelPath && (
                  <div className="model-path-block">
                    <span className="path-label">模型目录</span>
                    <div className="path-text" title={resolvedWhisperModelPath}>{resolvedWhisperModelPath}</div>
                  </div>
                )}
              </div>
            </div>
            {(!whisperModelStatus?.exists || isWhisperDownloading) && (
              <div className="model-actions">
                {!whisperModelStatus?.exists && !isWhisperDownloading && (
                  <button
                    className="btn-download"
                    onClick={handleDownloadWhisperModel}
                  >
                    <Download size={16} /> 下载模型
                  </button>
                )}
                {isWhisperDownloading && (
                  <div className="download-status">
                    <div className="status-header">
                      <span className="percent">{Math.round(whisperDownloadProgress)}%</span>
                      {whisperProgressData.total > 0 && (
                        <span className="details">
                          {formatBytes(whisperProgressData.downloaded)} / {formatBytes(whisperProgressData.total)}
                          <span className="speed">({formatBytes(whisperProgressData.speed)}/s)</span>
                        </span>
                      )}
                    </div>
                    <div className="progress-bar-mini">
                      <div className="fill" style={{ width: `${whisperDownloadProgress}%` }}></div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="sub-setting">
            <div className="sub-label">自定义模型目录</div>
            <div className="path-selector">
              <input
                type="text"
                value={whisperModelDir}
                readOnly
                placeholder="默认目录"
              />
              <button className="btn-icon" onClick={handleSelectWhisperModelDir} title="选择目录">
                <FolderOpen size={18} />
              </button>
              {whisperModelDir && (
                <button className="btn-icon danger" onClick={handleResetWhisperModelDir} title="重置为默认">
                  <RotateCcw size={18} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="form-group">
        <label>自动转文字</label>
        <span className="form-hint">收到语音消息时自动转换为文字</span>
        <div className="log-toggle-line">
          <span className="log-status">{autoTranscribeVoice ? '已开启' : '已关闭'}</span>
          <label className="switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={autoTranscribeVoice}
              onChange={(e) => {
                setAutoTranscribeVoice(e.target.checked)
                configService.setAutoTranscribeVoice(e.target.checked)
              }}
            />
            <span className="switch-slider"></span>
          </label>
        </div>
      </div>
    </div>
  )

  const renderCacheTab = () => (
      <div className="tab-content">
        <p className="section-desc">管理应用缓存数据</p>
        <div className="form-group">
          <label>缓存目录 <span className="optional">(可选)</span></label>
          <span className="form-hint">留空使用默认目录</span>
          <input
              type="text"
              placeholder="留空使用默认目录"
              value={cachePath}
              onChange={(e) => {
                const value = e.target.value
                setCachePath(value)
                scheduleConfigSave('cachePath', () => configService.setCachePath(value))
              }}
          />

          <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            当前缓存位置：
            <code style={{
              background: 'var(--bg-secondary)',
              padding: '3px 6px',
              borderRadius: '4px',
              userSelect: 'all',
              wordBreak: 'break-all',
              marginLeft: '4px'
            }}>
              {cachePath || (isMac ? '~/Documents/WeFlow' : isLinux ? '~/Documents/WeFlow' : '系统 文档\\WeFlow 目录')}
            </code>
          </div>

          <div className="btn-row" style={{ marginTop: '12px' }}>
            <button className="btn btn-secondary" onClick={handleSelectCachePath}><FolderOpen size={16} /> 浏览选择</button>
            <button
                className="btn btn-secondary"
                onClick={async () => {
                  setCachePath('')
                  await configService.setCachePath('')
                }}
            >
              <RotateCcw size={16} /> 恢复默认
            </button>
          </div>
        </div>

      <div className="btn-row">
        <button className="btn btn-secondary" onClick={handleClearAnalyticsCache} disabled={isClearingCache}>
          <Trash2 size={16} /> 清除分析缓存
        </button>
        <button className="btn btn-secondary" onClick={handleClearImageCache} disabled={isClearingCache}>
          <Trash2 size={16} /> 清除图片缓存
        </button>
        <button className="btn btn-danger" onClick={handleClearAllCache} disabled={isClearingCache}>
          <Trash2 size={16} /> 清除所有缓存</button>
      </div>
      <div className="divider" />
      <p className="section-desc">清除当前配置并重新开始首次引导</p>
      <div className="btn-row">
        <button className="btn btn-danger" onClick={handleClearConfig}>
          <RefreshCw size={16} /> 清除当前配置
        </button>
      </div>
    </div>
  )

  // HTTP API 服务控制
  const handleToggleApi = async () => {
    if (isTogglingApi) return

    // 启动时显示警告弹窗
    if (!httpApiRunning) {
      setShowApiWarning(true)
      return
    }

    setIsTogglingApi(true)
    try {
      await window.electronAPI.http.stop()
      setHttpApiRunning(false)
      await configService.setHttpApiEnabled(false)
      showMessage('API 服务已停止', true)
    } catch (e: any) {
      showMessage(`操作失败: ${e}`, false)
    } finally {
      setIsTogglingApi(false)
    }
  }

  // 确认启动 API 服务
  const confirmStartApi = async () => {
    setShowApiWarning(false)
    setIsTogglingApi(true)
    try {
      const result = await window.electronAPI.http.start(httpApiPort, httpApiHost)
      if (result.success) {
        setHttpApiRunning(true)
        if (result.port) setHttpApiPort(result.port)

        await configService.setHttpApiEnabled(true)
        await configService.setHttpApiPort(result.port || httpApiPort)

        showMessage(`API 服务已启动，端口 ${result.port}`, true)
      } else {
        showMessage(`启动失败: ${result.error}`, false)
      }
    } catch (e: any) {
      showMessage(`操作失败: ${e}`, false)
    } finally {
      setIsTogglingApi(false)
    }
  }

  const handleCopyApiUrl = () => {
    const url = `http://${httpApiHost}:${httpApiPort}`
    navigator.clipboard.writeText(url)
    showMessage('已复制 API 地址', true)
  }

  const handleToggleMessagePush = async (enabled: boolean) => {
    setMessagePushEnabled(enabled)
    await configService.setMessagePushEnabled(enabled)
    showMessage(enabled ? '已开启主动推送' : '已关闭主动推送', true)
  }

  const renderApiTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>HTTP API 服务</label>
        <span className="form-hint">启用后可通过 HTTP 接口查询消息数据（仅限本机访问）</span>
        <div className="log-toggle-line">
          <span className="log-status">
            {httpApiRunning ? '运行中' : '已停止'}
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={httpApiRunning}
              onChange={handleToggleApi}
              disabled={isTogglingApi}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>

      <div className="form-group">
        <label>监听地址</label>
        <span className="form-hint">
          API 服务绑定的主机地址。默认 <code>127.0.0.1</code> 仅本机访问；Docker/N8N 等容器场景请改为 <code>0.0.0.0</code> 以允许外部访问（注意配合 Token 鉴权）
        </span>
        <input
            type="text"
            className="field-input"
            value={httpApiHost}
            placeholder="127.0.0.1"
            onChange={(e) => {
              const host = e.target.value.trim() || '127.0.0.1'
              setHttpApiHost(host)
              scheduleConfigSave('httpApiHost', () => configService.setHttpApiHost(host))
            }}
            disabled={httpApiRunning}
            style={{ width: 180, fontFamily: 'monospace' }}
        />
      </div>

      <div className="form-group">
        <label>服务端口</label>
        <span className="form-hint">API 服务监听的端口号（1024-65535）</span>
        <input
            type="number"
            className="field-input"
            value={httpApiPort}
            onChange={(e) => {
              const port = parseInt(e.target.value, 10) || 5031
              setHttpApiPort(port)
              scheduleConfigSave('httpApiPort', () => configService.setHttpApiPort(port))
            }}
            disabled={httpApiRunning}
            style={{ width: 120 }}
            min={1024}
            max={65535}
        />
      </div>

      <div className="form-group">
        <label>Access Token (鉴权凭证)</label>
        <span className="form-hint">
          设置后，请求头需携带 <code>Authorization: Bearer &lt;token&gt;</code>，
          或者参数中携带 <code>?access_token=&lt;token&gt;</code>
        </span>
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <input
              type="text"
              className="field-input"
              value={httpApiToken}
              placeholder="留空表示不验证 Token"
              onChange={(e) => {
                const val = e.target.value
                setHttpApiToken(val)
                scheduleConfigSave('httpApiToken', () => configService.setHttpApiToken(val))
              }}
              style={{ flex: 1, fontFamily: 'monospace' }}
          />
          <button className="btn btn-secondary" onClick={generateRandomToken}>
            <RefreshCw size={14} style={{ marginRight: 4 }} /> 随机生成
          </button>
          {httpApiToken && (
              <button className="btn btn-danger" onClick={clearApiToken} title="清除 Token">
                <Trash2 size={14} />
              </button>
          )}
        </div>
      </div>

      {httpApiRunning && (
        <div className="form-group">
          <label>API 地址</label>
          <span className="form-hint">使用以下地址访问 API</span>
          <div className="api-url-display">
            <input
              type="text"
              className="field-input"
              value={`http://${httpApiHost}:${httpApiPort}`}
              readOnly
            />
            <button className="btn btn-secondary" onClick={handleCopyApiUrl} title="复制">
              <Copy size={16} />
            </button>
          </div>
        </div>
      )}

      {/* API 安全警告弹窗 */}
      <div className="form-group">
        <label>默认媒体导出目录</label>
        <span className="form-hint">`/api/v1/messages` 在开启 `media=1` 时会把媒体保存到这里</span>
        <input
          type="text"
          className="field-input"
          value={httpApiMediaExportPath || '未获取到目录'}
          readOnly
        />
      </div>

      <div className="divider" />

      <div className="form-group">
        <label>主动推送</label>
        <span className="form-hint">检测到新收到的消息后，会通过当前 API 端口下的固定 SSE 地址主动推送给外部订阅端</span>
        <div className="log-toggle-line">
          <span className="log-status">
            {messagePushEnabled ? '已开启' : '已关闭'}
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={messagePushEnabled}
              onChange={(e) => { void handleToggleMessagePush(e.target.checked) }}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>

      <div className="form-group">
        <label>推送地址</label>
        <span className="form-hint">外部软件连接这个 SSE 地址即可接收新消息推送；需要先开启上方 `HTTP API 服务`</span>
        <div className="api-url-display">
          <input
              type="text"
              className="field-input"
              value={`http://${httpApiHost}:${httpApiPort}/api/v1/push/messages${httpApiToken ? `?access_token=${httpApiToken}` : ''}`}
              readOnly
          />
          <button
              className="btn btn-secondary"
              onClick={() => {
                navigator.clipboard.writeText(`http://${httpApiHost}:${httpApiPort}/api/v1/push/messages${httpApiToken ? `?access_token=${httpApiToken}` : ''}`)
                showMessage('已复制推送地址', true)
              }}
              title="复制"
          >
            <Copy size={16} />
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>推送内容</label>
        <span className="form-hint">SSE 事件名为 `message.new`；私聊推送 `avatarUrl/sourceName/content`，群聊额外附带 `groupName`</span>
        <div className="api-docs">
          <div className="api-item">
            <div className="api-endpoint">
              <span className="method get">GET</span>
              <code>{`http://${httpApiHost}:${httpApiPort}/api/v1/push/messages`}</code>
            </div>
            <p className="api-desc">通过 SSE 长连接接收消息事件，建议接收端按 `messageKey` 去重。</p>
            <div className="api-params">
              {['event', 'sessionId', 'messageKey', 'avatarUrl', 'sourceName', 'groupName?', 'content'].map((param) => (
                <span key={param} className="param">
                  <code>{param}</code>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showApiWarning && (
        <div className="modal-overlay" onClick={() => setShowApiWarning(false)}>
          <div className="api-warning-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <ShieldCheck size={20} />
              <h3>安全提示</h3>
            </div>
            <div className="modal-body">
              <p className="warning-text">启用 HTTP API 服务后，本机上的其他程序可通过接口访问您的聊天记录数据。</p>
              <div className="warning-list">
                <div className="warning-item">
                  <span className="bullet">•</span>
                  <span>请确保您了解此功能的用途</span>
                </div>
                <div className="warning-item">
                  <span className="bullet">•</span>
                  <span>不要在公共或不信任的网络环境下使用</span>
                </div>
                <div className="warning-item">
                  <span className="bullet">•</span>
                  <span>此功能仅供高级用户或开发者使用</span>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowApiWarning(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={confirmStartApi}>
                确认启动
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  const handleSetupHello = async () => {
    if (!helloPassword) {
      showMessage('请输入当前密码以开启 Hello', false)
      return
    }
    if (!isWindows) {
      showMessage('当前系统不支持 Windows Hello', false)
      return
    }
    setIsSettingHello(true)
    try {
      const verifyResult = await window.electronAPI.auth.hello('请验证您的身份以开启 Windows Hello')
      if (!verifyResult.success) {
        showMessage(verifyResult.error || 'Windows Hello 验证失败', false)
        return
      }

      const saveResult = await window.electronAPI.auth.setHelloSecret(helloPassword)
      if (!saveResult.success) {
        showMessage('Windows Hello 配置保存失败', false)
        return
      }

      setAuthUseHello(true)
      setHelloPassword('')
      showMessage('Windows Hello 设置成功', true)
    } catch (e: any) {
      showMessage(`Windows Hello 设置失败: ${e?.message || String(e)}`, false)
    } finally {
      setIsSettingHello(false)
    }
  }

  const handleUpdatePassword = async () => {
    if (!newPassword || newPassword !== confirmPassword) {
      showMessage('两次密码不一致', false)
      return
    }

    try {
      const lockMode = await window.electronAPI.auth.isLockMode()

      if (authEnabled && lockMode) {
        // 已开启应用锁且已是 lock: 模式 → 修改密码
        if (!oldPassword) {
          showMessage('请输入旧密码', false)
          return
        }
        const result = await window.electronAPI.auth.changePassword(oldPassword, newPassword)
        if (result.success) {
          setNewPassword('')
          setConfirmPassword('')
          setOldPassword('')
          showMessage('密码已更新', true)
        } else {
          showMessage(result.error || '密码更新失败', false)
        }
      } else {
        // 未开启应用锁，或旧版 safe: 模式 → 开启/升级为 lock: 模式
        const result = await window.electronAPI.auth.enableLock(newPassword)
        if (result.success) {
          setAuthEnabled(true)
          setIsLockMode(true)
          setNewPassword('')
          setConfirmPassword('')
          setOldPassword('')
          showMessage('应用锁已开启', true)
        } else {
          showMessage(result.error || '开启失败', false)
        }
      }
    } catch (e: any) {
      showMessage('操作失败', false)
    }
  }

  const renderAnalyticsTab = () => (
    <div className="tab-content">
      <div className="settings-section">
        <h2>分析设置</h2>
        <div className="setting-item">
          <div className="setting-label">
            <span>词云排除词</span>
            <span className="setting-desc">输入不需要在词云和常用语中显示的词语，用换行分隔</span>
          </div>
          <div className="setting-control" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
            <textarea
              className="form-input"
              style={{ width: '100%', height: '200px', fontFamily: 'monospace' }}
              value={excludeWordsInput}
              onChange={(e) => setExcludeWordsInput(e.target.value)}
              placeholder="例如：
第一个词
第二个词
第三个词"
            />
            <div className="button-group">
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const words = excludeWordsInput.split('\n').map(w => w.trim()).filter(w => w.length > 0)
                  // 去重
                  const uniqueWords = Array.from(new Set(words))
                  await configService.setWordCloudExcludeWords(uniqueWords)
                  setWordCloudExcludeWords(uniqueWords)
                  setExcludeWordsInput(uniqueWords.join('\n'))
                  // Show success toast or feedback if needed (optional)
                }}
              >
                保存排除列表
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setExcludeWordsInput(wordCloudExcludeWords.join('\n'))
                }}
              >
                重置
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  const renderSecurityTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <label>应用锁状态</label>
            <span className="form-hint">{
              isLockMode ? '已开启' :
                authEnabled ? '旧版模式 — 请重新设置密码以升级为新模式提高安全性' :
                  '未开启 — 请设置密码以开启'
            }</span>
          </div>
          {authEnabled && !showDisableLockInput && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowDisableLockInput(true)}
            >
              关闭应用锁
            </button>
          )}
        </div>
        {showDisableLockInput && (
          <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
            <input
              type="password"
              className="field-input"
              placeholder="输入当前密码以关闭"
              value={disableLockPassword}
              onChange={e => setDisableLockPassword(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-primary btn-sm"
              disabled={!disableLockPassword}
              onClick={async () => {
                const result = await window.electronAPI.auth.disableLock(disableLockPassword)
                if (result.success) {
                  setAuthEnabled(false)
                  setAuthUseHello(false)
                  setIsLockMode(false)
                  setShowDisableLockInput(false)
                  setDisableLockPassword('')
                  showMessage('应用锁已关闭', true)
                } else {
                  showMessage(result.error || '关闭失败', false)
                }
              }}
            >确认</button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => { setShowDisableLockInput(false); setDisableLockPassword('') }}
            >取消</button>
          </div>
        )}
      </div>

      <div className="divider" />

      <div className="form-group">
        <label>{isLockMode ? '修改密码' : '设置密码并开启应用锁'}</label>
        <span className="form-hint">{isLockMode ? '修改应用锁密码（需要旧密码验证）' : '设置密码后将自动开启应用锁'}</span>

        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {isLockMode && (
            <input
              type="password"
              className="field-input"
              placeholder="旧密码"
              value={oldPassword}
              onChange={e => setOldPassword(e.target.value)}
            />
          )}
          <input
            type="password"
            className="field-input"
            placeholder="新密码"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              type="password"
              className="field-input"
              placeholder="确认新密码"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary" onClick={handleUpdatePassword} disabled={!newPassword}>
              {isLockMode ? '更新' : '开启'}
            </button>
          </div>
        </div>
      </div>

      <div className="divider" />

      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <label>Windows Hello</label>
            <span className="form-hint">使用面容、指纹快速解锁</span>
            {!authEnabled && <div className="form-hint warning" style={{ color: '#ff4d4f' }}>请先开启应用锁</div>}
            {!helloAvailable && authEnabled && <div className="form-hint warning" style={{ color: '#ff4d4f' }}>当前设备不支持 Windows Hello</div>}
          </div>

          <div>
            {authUseHello ? (
              <button className="btn btn-secondary btn-sm" onClick={async () => {
                await window.electronAPI.auth.clearHelloSecret()
                setAuthUseHello(false)
                showMessage('Windows Hello 已关闭', true)
              }}>关闭</button>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleSetupHello}
                disabled={!helloAvailable || isSettingHello || !authEnabled || !helloPassword}
              >
                {isSettingHello ? '设置中...' : '开启与设置'}
              </button>
            )}
          </div>
        </div>
        {!authUseHello && authEnabled && (
          <div style={{ marginTop: 10 }}>
            <input
              type="password"
              className="field-input"
              placeholder="输入当前密码以开启 Hello"
              value={helloPassword}
              onChange={e => setHelloPassword(e.target.value)}
            />
          </div>
        )}
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
              <p className="update-hint">新版 v{updateInfo.version} 可用</p>
              {isDownloading ? (
                <div className="update-progress">
                  <div className="progress-bar">
                    <div className="progress-inner" style={{ width: `${(downloadProgress?.percent || 0)}%` }} />
                  </div>
                  <span>{(downloadProgress?.percent || 0).toFixed(0)}%</span>
                </div>
              ) : (
                <button className="btn btn-primary" onClick={() => setShowUpdateDialog(true)}>
                  <Download size={16} /> 立即更新
                </button>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button className="btn btn-secondary" onClick={handleCheckUpdate} disabled={isCheckingUpdate}>
                <RefreshCw size={16} className={isCheckingUpdate ? 'spin' : ''} />
                {isCheckingUpdate ? '检查中...' : '检查更新'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="about-footer">
        <p className="about-desc">微信聊天记录分析工具</p>
        <div className="about-links">
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.shell.openExternal('https://github.com/hicccc77/WeFlow') }}>官网</a>
          <span>·</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.shell.openExternal('https://chatlab.fun') }}>ChatLab</a>
          <span>·</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.window.openAgreementWindow() }}>用户协议</a>
        </div>
        <p className="copyright">© 2025 WeFlow. All rights reserved.</p>

        <div className="log-toggle-line" style={{ marginTop: '16px', justifyContent: 'center' }}>
          <span style={{ fontSize: '13px', opacity: 0.7 }}>匿名数据收集</span>
          <label className="switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={analyticsConsent}
              onChange={async (e) => {
                const consent = e.target.checked
                setAnalyticsConsent(consent)
                await configService.setAnalyticsConsent(consent)
                showMessage(consent ? '已允许数据收集' : '已拒绝数据收集', true)
              }}
            />
            <span className="switch-slider"></span>
          </label>
        </div>
      </div>
    </div>
  )

  return (
    <div className={`settings-modal-overlay ${isClosing ? 'closing' : ''}`} onClick={handleClose}>
      <div className={`settings-page ${isClosing ? 'closing' : ''}`} onClick={(event) => event.stopPropagation()}>
        {message && <div className={`message-toast ${message.success ? 'success' : 'error'}`}>{message.text}</div>}

        {/* 多账号选择对话框 */}
        {showWxidSelect && wxidOptions.length > 1 && (
          <div className="wxid-dialog-overlay" onClick={() => setShowWxidSelect(false)}>
            <div className="wxid-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="wxid-dialog-header">
                <h3>检测到多个微信账号</h3>
                <p>请选择要使用的账号</p>
              </div>
              <div className="wxid-dialog-list">
                {wxidOptions.map((opt) => (
                    <div
                        key={opt.wxid}
                        className={`wxid-dialog-item ${opt.wxid === wxid ? 'active' : ''}`}
                        onClick={() => handleSelectWxid(opt.wxid)}
                    >
                      <div className="wxid-profile-row">
                        {opt.avatarUrl ? (
                            <img src={opt.avatarUrl} alt="avatar" className="wxid-avatar" />
                        ) : (
                            <div className="wxid-avatar-fallback"><UserRound size={18}/></div>
                        )}
                        <div className="wxid-info-col">
                          <span className="wxid-id">{opt.nickname || opt.wxid}</span>
                          {opt.nickname && <span className="wxid-date">{opt.wxid}</span>}
                        </div>
                      </div>
                      <span className="wxid-date" style={{marginLeft: 'auto'}}>最后修改 {new Date(opt.modifiedTime).toLocaleString()}</span>
                    </div>
                ))}
              </div>
              <div className="wxid-dialog-footer">
                <button className="btn btn-secondary" onClick={() => setShowWxidSelect(false)}>取消</button>
              </div>
            </div>
          </div>
        )}

        <div className="settings-header">
          <div className="settings-title-block">
            <h1>设置</h1>
          </div>
          <div className="settings-actions">
            <button className="btn btn-secondary" onClick={handleTestConnection} disabled={isLoading || isTesting}>
              <Plug size={16} /> {isTesting ? '测试中...' : '测试连接'}
            </button>
            {onClose && (
              <button type="button" className="settings-close-btn" onClick={handleClose} aria-label="关闭设置">
                <X size={18} />
              </button>
            )}
          </div>
        </div>

        <div className="settings-layout">
          <div className="settings-tabs" role="tablist" aria-label="设置项">
            {tabs.map(tab => (
              <button
                key={tab.id}
                className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <tab.icon size={16} />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          <div className="settings-body">
            {activeTab === 'appearance' && renderAppearanceTab()}
            {activeTab === 'notification' && renderNotificationTab()}
            {activeTab === 'database' && renderDatabaseTab()}
            {activeTab === 'models' && renderModelsTab()}
            {activeTab === 'cache' && renderCacheTab()}
            {activeTab === 'api' && renderApiTab()}
            {activeTab === 'analytics' && renderAnalyticsTab()}
            {activeTab === 'security' && renderSecurityTab()}
            {activeTab === 'about' && renderAboutTab()}
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsPage
