import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useThemeStore, themes } from '../stores/themeStore'
import { useAnalyticsStore } from '../stores/analyticsStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  Eye, EyeOff, FolderSearch, FolderOpen, Search, Copy,
  RotateCcw, Trash2, Plug, Check, Sun, Moon,
  Palette, Database, Download, HardDrive, Info, RefreshCw, ChevronDown, Mic,
  ShieldCheck, Fingerprint, Lock, KeyRound, Bell, Globe
} from 'lucide-react'
import { Avatar } from '../components/Avatar'
import './SettingsPage.scss'

type SettingsTab = 'appearance' | 'notification' | 'database' | 'models' | 'export' | 'cache' | 'api' | 'security' | 'about'

const tabs: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'notification', label: '通知', icon: Bell },
  { id: 'database', label: '数据库连接', icon: Database },
  { id: 'models', label: '模型管理', icon: Mic },
  { id: 'export', label: '导出', icon: Download },
  { id: 'cache', label: '缓存', icon: HardDrive },
  { id: 'api', label: 'API 服务', icon: Globe },
  { id: 'security', label: '安全', icon: ShieldCheck },
  { id: 'about', label: '关于', icon: Info }
]


interface WxidOption {
  wxid: string
  modifiedTime: number
}

function SettingsPage() {
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
  const clearAnalyticsStoreCache = useAnalyticsStore((state) => state.clearCache)

  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [decryptKey, setDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [dbPath, setDbPath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<WxidOption[]>([])
  const [showWxidSelect, setShowWxidSelect] = useState(false)
  const [showExportFormatSelect, setShowExportFormatSelect] = useState(false)
  const [showExportDateRangeSelect, setShowExportDateRangeSelect] = useState(false)
  const [showExportExcelColumnsSelect, setShowExportExcelColumnsSelect] = useState(false)
  const [showExportConcurrencySelect, setShowExportConcurrencySelect] = useState(false)
  const exportFormatDropdownRef = useRef<HTMLDivElement>(null)
  const exportDateRangeDropdownRef = useRef<HTMLDivElement>(null)
  const exportExcelColumnsDropdownRef = useRef<HTMLDivElement>(null)
  const exportConcurrencyDropdownRef = useRef<HTMLDivElement>(null)
  const [cachePath, setCachePath] = useState('')
  const [logEnabled, setLogEnabled] = useState(false)
  const [whisperModelName, setWhisperModelName] = useState('base')
  const [whisperModelDir, setWhisperModelDir] = useState('')
  const [isWhisperDownloading, setIsWhisperDownloading] = useState(false)
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState(0)
  const [whisperProgressData, setWhisperProgressData] = useState<{ downloaded: number; total: number; speed: number }>({ downloaded: 0, total: 0, speed: 0 })
  const [whisperModelStatus, setWhisperModelStatus] = useState<{ exists: boolean; modelPath?: string; tokensPath?: string } | null>(null)
  const [llamaModelStatus, setLlamaModelStatus] = useState<{ exists: boolean; path?: string; size?: number } | null>(null)
  const [isLlamaDownloading, setIsLlamaDownloading] = useState(false)
  const [llamaDownloadProgress, setLlamaDownloadProgress] = useState(0)
  const [llamaProgressData, setLlamaProgressData] = useState<{ downloaded: number; total: number; speed: number }>({ downloaded: 0, total: 0, speed: 0 })

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const [autoTranscribeVoice, setAutoTranscribeVoice] = useState(false)
  const [transcribeLanguages, setTranscribeLanguages] = useState<string[]>(['zh'])
  const [exportDefaultFormat, setExportDefaultFormat] = useState('excel')
  const [exportDefaultDateRange, setExportDefaultDateRange] = useState('today')
  const [exportDefaultMedia, setExportDefaultMedia] = useState(false)
  const [exportDefaultVoiceAsText, setExportDefaultVoiceAsText] = useState(true)
  const [exportDefaultExcelCompactColumns, setExportDefaultExcelCompactColumns] = useState(true)
  const [exportDefaultConcurrency, setExportDefaultConcurrency] = useState(2)

  const [notificationEnabled, setNotificationEnabled] = useState(true)
  const [notificationPosition, setNotificationPosition] = useState<'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'>('top-right')
  const [notificationFilterMode, setNotificationFilterMode] = useState<'all' | 'whitelist' | 'blacklist'>('all')
  const [notificationFilterList, setNotificationFilterList] = useState<string[]>([])
  const [filterSearchKeyword, setFilterSearchKeyword] = useState('')
  const [filterModeDropdownOpen, setFilterModeDropdownOpen] = useState(false)
  const [positionDropdownOpen, setPositionDropdownOpen] = useState(false)





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
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // 安全设置 state
  const [authEnabled, setAuthEnabled] = useState(false)
  const [authUseHello, setAuthUseHello] = useState(false)
  const [helloAvailable, setHelloAvailable] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSettingHello, setIsSettingHello] = useState(false)

  // HTTP API 设置 state
  const [httpApiEnabled, setHttpApiEnabled] = useState(false)
  const [httpApiPort, setHttpApiPort] = useState(5031)
  const [httpApiRunning, setHttpApiRunning] = useState(false)
  const [isTogglingApi, setIsTogglingApi] = useState(false)
  const [showApiWarning, setShowApiWarning] = useState(false)

  const isClearingCache = isClearingAnalyticsCache || isClearingImageCache || isClearingAllCache

  // 检查 Hello 可用性
  useEffect(() => {
    if (window.PublicKeyCredential) {
      void PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(setHelloAvailable)
    }
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
      } catch (e) {
        console.error('检查 API 状态失败:', e)
      }
    }
    checkApiStatus()
  }, [])

  async function sha256(message: string) {
    const msgBuffer = new TextEncoder().encode(message)
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    return hashHex
  }

  useEffect(() => {
    loadConfig()
    loadAppVersion()
    return () => {
      Object.values(saveTimersRef.current).forEach((timer) => clearTimeout(timer))
    }
  }, [])

  // 点击外部关闭下拉框
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (showExportFormatSelect && exportFormatDropdownRef.current && !exportFormatDropdownRef.current.contains(target)) {
        setShowExportFormatSelect(false)
      }
      if (showExportDateRangeSelect && exportDateRangeDropdownRef.current && !exportDateRangeDropdownRef.current.contains(target)) {
        setShowExportDateRangeSelect(false)
      }
      if (showExportExcelColumnsSelect && exportExcelColumnsDropdownRef.current && !exportExcelColumnsDropdownRef.current.contains(target)) {
        setShowExportExcelColumnsSelect(false)
      }
      if (showExportConcurrencySelect && exportConcurrencyDropdownRef.current && !exportConcurrencyDropdownRef.current.contains(target)) {
        setShowExportConcurrencySelect(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showExportFormatSelect, showExportDateRangeSelect, showExportExcelColumnsSelect, showExportConcurrencySelect])

  useEffect(() => {
    const removeDb = window.electronAPI.key.onDbKeyStatus((payload: { message: string; level: number }) => {
      setDbKeyStatus(payload.message)
    })
    const removeImage = window.electronAPI.key.onImageKeyStatus((payload: { message: string }) => {
      setImageKeyStatus(payload.message)
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
      }
    }
    if (filterModeDropdownOpen || positionDropdownOpen) {
      document.addEventListener('click', handleClickOutside)
    }
    return () => {
      document.removeEventListener('click', handleClickOutside)
    }
  }, [filterModeDropdownOpen, positionDropdownOpen])


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
      const savedExportDefaultFormat = await configService.getExportDefaultFormat()
      const savedExportDefaultDateRange = await configService.getExportDefaultDateRange()
      const savedExportDefaultMedia = await configService.getExportDefaultMedia()
      const savedExportDefaultVoiceAsText = await configService.getExportDefaultVoiceAsText()
      const savedExportDefaultExcelCompactColumns = await configService.getExportDefaultExcelCompactColumns()
      const savedExportDefaultConcurrency = await configService.getExportDefaultConcurrency()

      const savedNotificationEnabled = await configService.getNotificationEnabled()
      const savedNotificationPosition = await configService.getNotificationPosition()
      const savedNotificationFilterMode = await configService.getNotificationFilterMode()
      const savedNotificationFilterList = await configService.getNotificationFilterList()

      const savedAuthEnabled = await configService.getAuthEnabled()
      const savedAuthUseHello = await configService.getAuthUseHello()
      setAuthEnabled(savedAuthEnabled)
      setAuthUseHello(savedAuthUseHello)

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
      setExportDefaultFormat(savedExportDefaultFormat || 'excel')
      setExportDefaultDateRange(savedExportDefaultDateRange || 'today')
      setExportDefaultMedia(savedExportDefaultMedia ?? false)
      setExportDefaultVoiceAsText(savedExportDefaultVoiceAsText ?? true)
      setExportDefaultExcelCompactColumns(savedExportDefaultExcelCompactColumns ?? true)
      setExportDefaultConcurrency(savedExportDefaultConcurrency ?? 2)

      setNotificationEnabled(savedNotificationEnabled)
      setNotificationPosition(savedNotificationPosition)
      setNotificationFilterMode(savedNotificationFilterMode)
      setNotificationFilterList(savedNotificationFilterList)

      // 如果语言列表为空，保存默认值
      if (!savedTranscribeLanguages || savedTranscribeLanguages.length === 0) {
        const defaultLanguages = ['zh']
        setTranscribeLanguages(defaultLanguages)
        await configService.setTranscribeLanguages(defaultLanguages)
      }


      if (savedWhisperModelDir) setWhisperModelDir(savedWhisperModelDir)

      // Load Llama status after config
      void checkLlamaModelStatus()
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
        setWxidOptions(wxids)
        if (wxids.length === 1) {
          await applyWxidSelection(wxids[0].wxid, {
            toastText: `已检测到账号：${wxids[0].wxid}`
          })
        } else if (wxids.length > 1) {
          setShowWxidSelect(true)
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
        setDbPath(selectedPath)
        await configService.setDbPath(selectedPath)
        showMessage('已选择数据库目录', true)
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
        await checkLlamaModelStatus()
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
    await checkLlamaModelStatus()
  }

  const checkLlamaModelStatus = async () => {
    try {
      // @ts-ignore
      const modelsPath = await window.electronAPI.llama?.getModelsPath()
      if (!modelsPath) return
      const modelName = "Qwen3-4B-Q4_K_M.gguf" // Hardcoded preset for now
      const fullPath = `${modelsPath}\\${modelName}`
      // @ts-ignore
      const status = await window.electronAPI.llama?.getModelStatus(fullPath)
      if (status) {
        setLlamaModelStatus({
          exists: status.exists,
          path: status.path,
          size: status.size
        })
      }
    } catch (e) {
      console.error("Check llama model status failed", e)
    }
  }

  useEffect(() => {
    const handleLlamaProgress = (payload: { downloaded: number; total: number; speed: number }) => {
      setLlamaProgressData(payload)
      if (payload.total > 0) {
        setLlamaDownloadProgress((payload.downloaded / payload.total) * 100)
      }
    }
    // @ts-ignore
    const removeListener = window.electronAPI.llama?.onDownloadProgress(handleLlamaProgress)
    return () => {
      if (typeof removeListener === 'function') removeListener()
    }
  }, [])

  const handleDownloadLlamaModel = async () => {
    if (isLlamaDownloading) return
    setIsLlamaDownloading(true)
    setLlamaDownloadProgress(0)
    try {
      const modelUrl = "https://www.modelscope.cn/models/Qwen/Qwen3-4B-GGUF/resolve/master/Qwen3-4B-Q4_K_M.gguf"
      // @ts-ignore
      const modelsPath = await window.electronAPI.llama?.getModelsPath()
      const modelName = "Qwen3-4B-Q4_K_M.gguf"
      const fullPath = `${modelsPath}\\${modelName}`

      // @ts-ignore
      const result = await window.electronAPI.llama?.downloadModel(modelUrl, fullPath)
      if (result?.success) {
        showMessage('Qwen3 模型下载完成', true)
        await checkLlamaModelStatus()
      } else {
        showMessage(`模型下载失败: ${result?.error || '未知错误'}`, false)
      }
    } catch (e: any) {
      showMessage(`模型下载失败: ${e}`, false)
    } finally {
      setIsLlamaDownloading(false)
    }
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
    if (isFetchingImageKey) return
    if (!dbPath) {
      showMessage('请先选择数据库目录', false)
      return
    }
    setIsFetchingImageKey(true)
    setImageKeyStatus('正在准备获取图片密钥...')
    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.key.autoGetImageKey(accountPath)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') {
          setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        }
        setImageAesKey(result.aesKey)
        setImageKeyStatus('已获取图片密钥')
        showMessage('已自动获取图片密钥', true)

        // Auto-save after fetching keys
        // We need to use the values directly because state updates are async
        const newXorKey = typeof result.xorKey === 'number' ? result.xorKey : 0
        const newAesKey = result.aesKey

        await configService.setImageXorKey(newXorKey)
        await configService.setImageAesKey(newAesKey)

        if (wxid) {
          await configService.setWxidConfig(wxid, {
            decryptKey: decryptKey, // use current state as it hasn't changed here
            imageXorKey: newXorKey,
            imageAesKey: newAesKey
          })
        }

      } else {
        showMessage(result.error || '自动获取图片密钥失败', false)
      }
    } catch (e: any) {
      showMessage(`自动获取图片密钥失败: ${e}`, false)
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
          <div className="custom-select">
            <div
              className={`custom-select-trigger ${positionDropdownOpen ? 'open' : ''}`}
              onClick={() => setPositionDropdownOpen(!positionDropdownOpen)}
            >
              <span className="custom-select-value">
                {notificationPosition === 'top-right' ? '右上角' :
                  notificationPosition === 'bottom-right' ? '右下角' :
                    notificationPosition === 'top-left' ? '左上角' : '左下角'}
              </span>
              <ChevronDown size={14} className={`custom-select-arrow ${positionDropdownOpen ? 'rotate' : ''}`} />
            </div>
            <div className={`custom-select-dropdown ${positionDropdownOpen ? 'open' : ''}`}>
              {[
                { value: 'top-right', label: '右上角' },
                { value: 'bottom-right', label: '右下角' },
                { value: 'top-left', label: '左上角' },
                { value: 'bottom-left', label: '左下角' }
              ].map(option => (
                <div
                  key={option.value}
                  className={`custom-select-option ${notificationPosition === option.value ? 'selected' : ''}`}
                  onClick={async () => {
                    const val = option.value as 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
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
        <span className="form-hint" style={{ color: '#ff6b6b' }}> 目录路径不可包含中文，如有中文请去微信-设置-存储位置点击更改，迁移至全英文目录</span>
        <input
          type="text"
          placeholder="例如: C:\Users\xxx\Documents\xwechat_files"
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
        <button className="btn btn-secondary btn-sm" onClick={handleAutoGetImageKey} disabled={isFetchingImageKey}>
          <Plug size={14} /> {isFetchingImageKey ? '获取中...' : '自动获取图片密钥'}
        </button>
        {imageKeyStatus && <div className="form-hint status-text">{imageKeyStatus}</div>}
        {isFetchingImageKey && <div className="form-hint status-text">正在扫描内存，请稍候...</div>}
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
  const renderModelsTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>模型管理</label>
        <span className="form-hint">管理语音识别和 AI 对话模型</span>
      </div>

      <div className="form-group">
        <label>语音识别模型 (Whisper)</label>
        <span className="form-hint">用于语音消息转文字功能</span>

        <div className="setting-control vertical has-border">
          <div className="model-status-card">
            <div className="model-info">
              <div className="model-name">SenseVoiceSmall (245 MB)</div>
              <div className="model-path">
                {whisperModelStatus?.exists ? (
                  <span className="status-indicator success"><Check size={14} /> 已安装</span>
                ) : (
                  <span className="status-indicator warning">未安装</span>
                )}
                {whisperModelDir && <div className="path-text" title={whisperModelDir}>{whisperModelDir}</div>}
              </div>
            </div>
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
        <label>AI 对话模型 (Llama)</label>
        <span className="form-hint">用于 AI 助手对话功能</span>
        <div className="setting-control vertical has-border">
          <div className="model-status-card">
            <div className="model-info">
              <div className="model-name">Qwen3 4B (Preset) (~2.6GB)</div>
              <div className="model-path">
                {llamaModelStatus?.exists ? (
                  <span className="status-indicator success"><Check size={14} /> 已安装</span>
                ) : (
                  <span className="status-indicator warning">未安装</span>
                )}
                {llamaModelStatus?.path && <div className="path-text" title={llamaModelStatus.path}>{llamaModelStatus.path}</div>}
              </div>
            </div>
            <div className="model-actions">
              {!llamaModelStatus?.exists && !isLlamaDownloading && (
                <button
                  className="btn-download"
                  onClick={handleDownloadLlamaModel}
                >
                  <Download size={16} /> 下载模型
                </button>
              )}
              {isLlamaDownloading && (
                <div className="download-status">
                  <div className="status-header">
                    <span className="percent">{Math.floor(llamaDownloadProgress)}%</span>
                    <span className="metrics">
                      {formatBytes(llamaProgressData.downloaded)} / {formatBytes(llamaProgressData.total)}
                      <span className="speed">({formatBytes(llamaProgressData.speed)}/s)</span>
                    </span>
                  </div>
                  <div className="progress-bar-mini">
                    <div className="fill" style={{ width: `${llamaDownloadProgress}%` }}></div>
                  </div>
                </div>
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

  const exportFormatOptions = [
    { value: 'excel', label: 'Excel', desc: '电子表格，适合统计分析' },
    { value: 'chatlab', label: 'ChatLab', desc: '标准格式，支持其他软件导入' },
    { value: 'chatlab-jsonl', label: 'ChatLab JSONL', desc: '流式格式，适合大量消息' },
    { value: 'json', label: 'JSON', desc: '详细格式，包含完整消息信息' },
    { value: 'html', label: 'HTML', desc: '网页格式，可直接浏览' },
    { value: 'txt', label: 'TXT', desc: '纯文本，通用格式' },
    { value: 'sql', label: 'PostgreSQL', desc: '数据库脚本，便于导入到数据库' }
  ]
  const exportDateRangeOptions = [
    { value: 'today', label: '今天' },
    { value: '7d', label: '最近7天' },
    { value: '30d', label: '最近30天' },
    { value: '90d', label: '最近90天' },
    { value: 'all', label: '全部时间' }
  ]
  const exportExcelColumnOptions = [
    { value: 'compact', label: '精简列', desc: '序号、时间、发送者身份、消息类型、内容' },
    { value: 'full', label: '完整列', desc: '含发送者昵称/微信ID/备注' }
  ]

  const exportConcurrencyOptions = [
    { value: 1, label: '1' },
    { value: 2, label: '2' },
    { value: 3, label: '3' },
    { value: 4, label: '4' },
    { value: 5, label: '5' },
    { value: 6, label: '6' }
  ]

  const getOptionLabel = (options: { value: string; label: string }[], value: string) => {
    return options.find((option) => option.value === value)?.label ?? value
  }

  const renderExportTab = () => {
    const exportExcelColumnsValue = exportDefaultExcelCompactColumns ? 'compact' : 'full'
    const exportFormatLabel = getOptionLabel(exportFormatOptions, exportDefaultFormat)
    const exportDateRangeLabel = getOptionLabel(exportDateRangeOptions, exportDefaultDateRange)
    const exportExcelColumnsLabel = getOptionLabel(exportExcelColumnOptions, exportExcelColumnsValue)
    const exportConcurrencyLabel = String(exportDefaultConcurrency)

    return (
      <div className="tab-content">
        <div className="form-group">
          <label>默认导出格式</label>
          <span className="form-hint">导出页面默认选中的格式</span>
          <div className="select-field" ref={exportFormatDropdownRef}>
            <button
              type="button"
              className={`select-trigger ${showExportFormatSelect ? 'open' : ''}`}
              onClick={() => {
                setShowExportFormatSelect(!showExportFormatSelect)
                setShowExportDateRangeSelect(false)
                setShowExportExcelColumnsSelect(false)
                setShowExportConcurrencySelect(false)
              }}
            >
              <span className="select-value">{exportFormatLabel}</span>
              <ChevronDown size={16} />
            </button>
            {showExportFormatSelect && (
              <div className="select-dropdown">
                {exportFormatOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`select-option ${exportDefaultFormat === option.value ? 'active' : ''}`}
                    onClick={async () => {
                      setExportDefaultFormat(option.value)
                      await configService.setExportDefaultFormat(option.value)
                      showMessage('已更新导出格式默认值', true)
                      setShowExportFormatSelect(false)
                    }}
                  >
                    <span className="option-label">{option.label}</span>
                    {option.desc && <span className="option-desc">{option.desc}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="form-group">
          <label>默认导出时间范围</label>
          <span className="form-hint">控制导出页面的默认时间选择</span>
          <div className="select-field" ref={exportDateRangeDropdownRef}>
            <button
              type="button"
              className={`select-trigger ${showExportDateRangeSelect ? 'open' : ''}`}
              onClick={() => {
                setShowExportDateRangeSelect(!showExportDateRangeSelect)
                setShowExportFormatSelect(false)
                setShowExportExcelColumnsSelect(false)
                setShowExportConcurrencySelect(false)
              }}
            >
              <span className="select-value">{exportDateRangeLabel}</span>
              <ChevronDown size={16} />
            </button>
            {showExportDateRangeSelect && (
              <div className="select-dropdown">
                {exportDateRangeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`select-option ${exportDefaultDateRange === option.value ? 'active' : ''}`}
                    onClick={async () => {
                      setExportDefaultDateRange(option.value)
                      await configService.setExportDefaultDateRange(option.value)
                      showMessage('已更新默认导出时间范围', true)
                      setShowExportDateRangeSelect(false)
                    }}
                  >
                    <span className="option-label">{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="form-group">
          <label>默认导出媒体文件</label>
          <span className="form-hint">控制图片/语音/表情的默认导出开关</span>
          <div className="log-toggle-line">
            <span className="log-status">{exportDefaultMedia ? '已开启' : '已关闭'}</span>
            <label className="switch" htmlFor="export-default-media">
              <input
                id="export-default-media"
                className="switch-input"
                type="checkbox"
                checked={exportDefaultMedia}
                onChange={async (e) => {
                  const enabled = e.target.checked
                  setExportDefaultMedia(enabled)
                  await configService.setExportDefaultMedia(enabled)
                  showMessage(enabled ? '已开启默认媒体导出' : '已关闭默认媒体导出', true)
                }}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        <div className="form-group">
          <label>默认语音转文字</label>
          <span className="form-hint">导出时默认将语音转写为文字</span>
          <div className="log-toggle-line">
            <span className="log-status">{exportDefaultVoiceAsText ? '已开启' : '已关闭'}</span>
            <label className="switch" htmlFor="export-default-voice-as-text">
              <input
                id="export-default-voice-as-text"
                className="switch-input"
                type="checkbox"
                checked={exportDefaultVoiceAsText}
                onChange={async (e) => {
                  const enabled = e.target.checked
                  setExportDefaultVoiceAsText(enabled)
                  await configService.setExportDefaultVoiceAsText(enabled)
                  showMessage(enabled ? '已开启默认语音转文字' : '已关闭默认语音转文字', true)
                }}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        <div className="form-group">
          <label>Excel 列显示</label>
          <span className="form-hint">控制 Excel 导出的列字段</span>
          <div className="select-field" ref={exportExcelColumnsDropdownRef}>
            <button
              type="button"
              className={`select-trigger ${showExportExcelColumnsSelect ? 'open' : ''}`}
              onClick={() => {
                setShowExportExcelColumnsSelect(!showExportExcelColumnsSelect)
                setShowExportFormatSelect(false)
                setShowExportDateRangeSelect(false)
                setShowExportConcurrencySelect(false)
              }}
            >
              <span className="select-value">{exportExcelColumnsLabel}</span>
              <ChevronDown size={16} />
            </button>
            {showExportExcelColumnsSelect && (
              <div className="select-dropdown">
                {exportExcelColumnOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`select-option ${exportExcelColumnsValue === option.value ? 'active' : ''}`}
                    onClick={async () => {
                      const compact = option.value === 'compact'
                      setExportDefaultExcelCompactColumns(compact)
                      await configService.setExportDefaultExcelCompactColumns(compact)
                      showMessage(compact ? '已启用精简列' : '已启用完整列', true)
                      setShowExportExcelColumnsSelect(false)
                    }}
                  >
                    <span className="option-label">{option.label}</span>
                    {option.desc && <span className="option-desc">{option.desc}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="form-group">
          <label>导出并发数</label>
          <span className="form-hint">导出多个会话时的最大并发（1~6）</span>
          <div className="select-field" ref={exportConcurrencyDropdownRef}>
            <button
              type="button"
              className={`select-trigger ${showExportConcurrencySelect ? 'open' : ''}`}
              onClick={() => {
                setShowExportConcurrencySelect(!showExportConcurrencySelect)
                setShowExportFormatSelect(false)
                setShowExportDateRangeSelect(false)
                setShowExportExcelColumnsSelect(false)
              }}
            >
              <span className="select-value">{exportConcurrencyLabel}</span>
              <ChevronDown size={16} />
            </button>
            {showExportConcurrencySelect && (
              <div className="select-dropdown">
                {exportConcurrencyOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`select-option ${exportDefaultConcurrency === option.value ? 'active' : ''}`}
                    onClick={async () => {
                      setExportDefaultConcurrency(option.value)
                      await configService.setExportDefaultConcurrency(option.value)
                      showMessage(`已将导出并发数设为 ${option.value}`, true)
                      setShowExportConcurrencySelect(false)
                    }}
                  >
                    <span className="option-label">{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    )
  }
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
        <div className="btn-row">
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
      const result = await window.electronAPI.http.start(httpApiPort)
      if (result.success) {
        setHttpApiRunning(true)
        if (result.port) setHttpApiPort(result.port)
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
    const url = `http://127.0.0.1:${httpApiPort}`
    navigator.clipboard.writeText(url)
    showMessage('已复制 API 地址', true)
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
        <label>服务端口</label>
        <span className="form-hint">API 服务监听的端口号（1024-65535）</span>
        <input
          type="number"
          className="field-input"
          value={httpApiPort}
          onChange={(e) => setHttpApiPort(parseInt(e.target.value, 10) || 5031)}
          disabled={httpApiRunning}
          style={{ width: 120 }}
          min={1024}
          max={65535}
        />
      </div>

      {httpApiRunning && (
        <div className="form-group">
          <label>API 地址</label>
          <span className="form-hint">使用以下地址访问 API</span>
          <div className="api-url-display">
            <input
              type="text"
              className="field-input"
              value={`http://127.0.0.1:${httpApiPort}`}
              readOnly
            />
            <button className="btn btn-secondary" onClick={handleCopyApiUrl} title="复制">
              <Copy size={16} />
            </button>
          </div>
        </div>
      )}

      {/* API 安全警告弹窗 */}
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
    setIsSettingHello(true)
    try {
      const challenge = new Uint8Array(32)
      window.crypto.getRandomValues(challenge)

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'WeFlow', id: 'localhost' },
          user: { id: new Uint8Array([1]), name: 'user', displayName: 'User' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
          authenticatorSelection: { userVerification: 'required' },
          timeout: 60000
        }
      })

      if (credential) {
        setAuthUseHello(true)
        await configService.setAuthUseHello(true)
        showMessage('Windows Hello 设置成功', true)
      }
    } catch (e: any) {
      if (e.name !== 'NotAllowedError') {
        showMessage(`Windows Hello 设置失败: ${e.message}`, false)
      }
    } finally {
      setIsSettingHello(false)
    }
  }

  const handleUpdatePassword = async () => {
    if (!newPassword || newPassword !== confirmPassword) {
      showMessage('两次密码不一致', false)
      return
    }

    // 简单的保存逻辑，实际上应该先验证旧密码，但为了简化流程，这里直接允许覆盖
    // 因为能进入设置页面说明已经解锁了
    try {
      const hash = await sha256(newPassword)
      await configService.setAuthPassword(hash)
      await configService.setAuthEnabled(true)
      setAuthEnabled(true)
      setNewPassword('')
      setConfirmPassword('')
      showMessage('密码已更新', true)
    } catch (e: any) {
      showMessage('密码更新失败', false)
    }
  }

  const renderSecurityTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <label>启用应用锁</label>
            <span className="form-hint">每次启动应用时需要验证密码</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={authEnabled}
              onChange={async (e) => {
                const enabled = e.target.checked
                setAuthEnabled(enabled)
                await configService.setAuthEnabled(enabled)
              }}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>

      <div className="divider" />

      <div className="form-group">
        <label>重置密码</label>
        <span className="form-hint">设置新的启动密码</span>

        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
            <button className="btn btn-primary" onClick={handleUpdatePassword} disabled={!newPassword}>更新</button>
          </div>
        </div>
      </div>

      <div className="divider" />

      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <label>Windows Hello</label>
            <span className="form-hint">使用面容、指纹快速解锁</span>
            {!helloAvailable && <div className="form-hint warning" style={{ color: '#ff4d4f' }}> 当前设备不支持 Windows Hello</div>}
          </div>

          <div>
            {authUseHello ? (
              <button className="btn btn-secondary btn-sm" onClick={() => setAuthUseHello(false)}>关闭</button>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleSetupHello}
                disabled={!helloAvailable || isSettingHello}
              >
                {isSettingHello ? '设置中...' : '开启与设置'}
              </button>
            )}
          </div>
        </div>
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
      </div>
    </div>
  )

  return (
    <div className="settings-page">
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
                  <span className="wxid-id">{opt.wxid}</span>
                  <span className="wxid-date">最后修改 {new Date(opt.modifiedTime).toLocaleString()}</span>
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
        <h1>设置</h1>
        <div className="settings-actions">
          <button className="btn btn-secondary" onClick={handleTestConnection} disabled={isLoading || isTesting}>
            <Plug size={16} /> {isTesting ? '测试中...' : '测试连接'}
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
        {activeTab === 'notification' && renderNotificationTab()}
        {activeTab === 'database' && renderDatabaseTab()}
        {activeTab === 'models' && renderModelsTab()}
        {activeTab === 'export' && renderExportTab()}
        {activeTab === 'cache' && renderCacheTab()}
        {activeTab === 'api' && renderApiTab()}
        {activeTab === 'security' && renderSecurityTab()}
        {activeTab === 'about' && renderAboutTab()}
      </div>

    </div>
  )
}

export default SettingsPage
