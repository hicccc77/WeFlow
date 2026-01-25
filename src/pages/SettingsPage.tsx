import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useThemeStore, themes } from '../stores/themeStore'
import { useAnalyticsStore } from '../stores/analyticsStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  Eye, EyeOff, FolderSearch, FolderOpen, Search, Copy,
  RotateCcw, Trash2, Save, Plug, Check, Sun, Moon,
  Palette, Database, Download, HardDrive, Info, RefreshCw, ChevronDown, Mic
} from 'lucide-react'
import './SettingsPage.scss'

type SettingsTab = 'appearance' | 'database' | 'whisper' | 'export' | 'cache' | 'about'

const tabs: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'database', label: '数据库连接', icon: Database },
  { id: 'whisper', label: '语音识别模型', icon: Mic },
  { id: 'export', label: '导出', icon: Download },
  { id: 'cache', label: '缓存', icon: HardDrive },
  { id: 'about', label: '关于', icon: Info }
]

interface WxidOption {
  wxid: string
  modifiedTime: number
}

function SettingsPage() {
  const { isDbConnected, setDbConnected, setLoading, reset } = useAppStore()
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
  const exportFormatDropdownRef = useRef<HTMLDivElement>(null)
  const exportDateRangeDropdownRef = useRef<HTMLDivElement>(null)
  const exportExcelColumnsDropdownRef = useRef<HTMLDivElement>(null)
  const [cachePath, setCachePath] = useState('')
  const [logEnabled, setLogEnabled] = useState(false)
  const [whisperModelName, setWhisperModelName] = useState('base')
  const [whisperModelDir, setWhisperModelDir] = useState('')
  const [isWhisperDownloading, setIsWhisperDownloading] = useState(false)
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState(0)
  const [whisperModelStatus, setWhisperModelStatus] = useState<{ exists: boolean; modelPath?: string; tokensPath?: string } | null>(null)
  const [autoTranscribeVoice, setAutoTranscribeVoice] = useState(false)
  const [transcribeLanguages, setTranscribeLanguages] = useState<string[]>(['zh'])
  const [exportDefaultFormat, setExportDefaultFormat] = useState('excel')
  const [exportDefaultDateRange, setExportDefaultDateRange] = useState('today')
  const [exportDefaultMedia, setExportDefaultMedia] = useState(false)
  const [exportDefaultVoiceAsText, setExportDefaultVoiceAsText] = useState(true)
  const [exportDefaultExcelCompactColumns, setExportDefaultExcelCompactColumns] = useState(true)

  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [appVersion, setAppVersion] = useState('')
  const [updateInfo, setUpdateInfo] = useState<{ hasUpdate: boolean; version?: string; releaseNotes?: string } | null>(null)
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [isManualStartPrompt, setIsManualStartPrompt] = useState(false)
  const [isClearingAnalyticsCache, setIsClearingAnalyticsCache] = useState(false)
  const [isClearingImageCache, setIsClearingImageCache] = useState(false)
  const [isClearingAllCache, setIsClearingAllCache] = useState(false)

  const isClearingCache = isClearingAnalyticsCache || isClearingImageCache || isClearingAllCache

  useEffect(() => {
    loadConfig()
    loadAppVersion()
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
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showExportFormatSelect, showExportDateRangeSelect, showExportExcelColumnsSelect])

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

      // 如果语言列表为空，保存默认值
      if (!savedTranscribeLanguages || savedTranscribeLanguages.length === 0) {
        const defaultLanguages = ['zh']
        setTranscribeLanguages(defaultLanguages)
        await configService.setTranscribeLanguages(defaultLanguages)
      }


      if (savedWhisperModelDir) setWhisperModelDir(savedWhisperModelDir)
    } catch (e) {
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

  useEffect(() => {
    const removeListener = window.electronAPI.whisper?.onDownloadProgress?.((payload) => {
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
    setIsCheckingUpdate(true)
    setUpdateInfo(null)
    try {
      const result = await window.electronAPI.app.checkForUpdates()
      if (result.hasUpdate) {
        setUpdateInfo(result)
        showMessage(`发现新版：${result.version}`, true)
      } else {
        showMessage('当前已是最新版', true)
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
    options?: { preferCurrentKeys?: boolean; showToast?: boolean; toastText?: string }
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
    const keys = preferCurrentKeys
      ? buildKeysFromState()
      : buildKeysFromConfig(await configService.getWxidConfig(selectedWxid))

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
      } catch (e) {
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

  const handleScanWxid = async (
    silent = false,
    options?: { preferCurrentKeys?: boolean; showDialog?: boolean }
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
          toastText: `已检测到账号：${wxids[0].wxid}`
        })
      } else if (wxids.length > 1 && allowDialog) {
        setShowWxidSelect(true)
      } else {
        if (!silent) showMessage('未检测到账号目录，请检查路径', false)
      }
    } catch (e) {
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
        setCachePath(result.filePaths[0])
        showMessage('已选择缓存目录', true)
      }
    } catch (e) {
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
    } catch (e) {
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
    } catch (e) {
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
        await handleScanWxid(true, { preferCurrentKeys: true, showDialog: false })
      } else {
        if (result.error?.includes('未找到微信安装路径') || result.error?.includes('启动微信失败')) {
          setIsManualStartPrompt(true)
          setDbKeyStatus('需要手动启动微信')
        } else {
          showMessage(result.error || '自动获取密钥失败', false)
        }
      }
    } catch (e) {
      showMessage(`自动获取密钥失败: ${e}`, false)
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
      } else {
        showMessage(result.error || '自动获取图片密钥失败', false)
      }
    } catch (e) {
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
      const parsedXorKey = parseImageXorKey(imageXorKey)
      await configService.setImageXorKey(typeof parsedXorKey === 'number' ? parsedXorKey : 0)
      await configService.setImageAesKey(imageAesKey || '')
      await configService.setWxidConfig(wxid, {
        decryptKey,
        imageXorKey: typeof parsedXorKey === 'number' ? parsedXorKey : 0,
        imageAesKey
      })
      await configService.setWhisperModelDir(whisperModelDir)
      await configService.setAutoTranscribeVoice(autoTranscribeVoice)
      await configService.setTranscribeLanguages(transcribeLanguages)
      await configService.setOnboardingDone(true)

      // 保存按钮只负责持久化配置，不做连接测试/重连，避免影响聊天页的活动连接
      showMessage('配置保存成功', true)
    } catch (e) {
      showMessage(`保存配置失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

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
    } catch (e) {
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
    } catch (e) {
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
    } catch (e) {
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
    } catch (e) {
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
        <span className="form-hint" style={{ color: '#ff6b6b' }}>⚠️ 目录路径不可包含中文，如有中文请去微信-设置-存储位置点击更改，迁移至全英文目录</span>
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
        <div className="wxid-input-wrapper">
          <input
            type="text"
            placeholder="例如: wxid_xxxxxx"
            value={wxid}
            onChange={(e) => setWxid(e.target.value)}
          />
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => handleScanWxid()}><Search size={14} /> 扫描 wxid</button>
      </div>

      <div className="form-group">
        <label>图片 XOR 密钥 <span className="optional">(可选)</span></label>
        <span className="form-hint">用于解密图片缓存</span>
        <input type="text" placeholder="例如: 0xA4" value={imageXorKey} onChange={(e) => setImageXorKey(e.target.value)} />
      </div>

      <div className="form-group">
        <label>图片 AES 密钥 <span className="optional">(可选)</span></label>
        <span className="form-hint">16 位密钥</span>
        <input type="text" placeholder="16 位 AES 密钥" value={imageAesKey} onChange={(e) => setImageAesKey(e.target.value)} />
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
  const renderWhisperTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>自动语音转文字</label>
        <span className="form-hint">语音解密后自动转写为文字（需下载模型）</span>
        <div className="log-toggle-line">
          <span className="log-status">{autoTranscribeVoice ? '已开启' : '已关闭'}</span>
          <label className="switch" htmlFor="auto-transcribe-toggle">
            <input
              id="auto-transcribe-toggle"
              className="switch-input"
              type="checkbox"
              checked={autoTranscribeVoice}
              onChange={async (e) => {
                const enabled = e.target.checked
                setAutoTranscribeVoice(enabled)
                await configService.setAutoTranscribeVoice(enabled)
                showMessage(enabled ? '已开启自动转文字' : '已关闭自动转文字', true)
              }}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>
      <div className="form-group">
        <label>支持的语言</label>
        <span className="form-hint">选择需要识别的语言（至少选择一种）</span>
        <div className="language-checkboxes">
          {[
            { code: 'zh', name: '中文' },
            { code: 'yue', name: '粤语' },
            { code: 'en', name: '英文' },
            { code: 'ja', name: '日文' },
            { code: 'ko', name: '韩文' }
          ].map((lang) => (
            <label key={lang.code} className="language-checkbox">
              <input
                type="checkbox"
                checked={transcribeLanguages.includes(lang.code)}
                onChange={async (e) => {
                  const checked = e.target.checked
                  let newLanguages: string[]

                  if (checked) {
                    newLanguages = [...transcribeLanguages, lang.code]
                  } else {
                    if (transcribeLanguages.length <= 1) {
                      showMessage('至少需要选择一种语言', false)
                      return
                    }
                    newLanguages = transcribeLanguages.filter(l => l !== lang.code)
                  }

                  setTranscribeLanguages(newLanguages)
                  await configService.setTranscribeLanguages(newLanguages)
                  showMessage(`已${checked ? '添加' : '移除'}${lang.name}`, true)
                }}
              />
              <div className="checkbox-custom">
                <Check size={14} />
                <span>{lang.name}</span>
              </div>
            </label>
          ))}
        </div>
      </div>
      <div className="form-group whisper-section">
        <label>语音识别模型 (SenseVoiceSmall)</label>
        <span className="form-hint">基于 Sherpa-onnx，支持中、粤、英、日、韩及情感/事件识别</span>
        <span className="form-hint">模型下载目录</span>
        <input
          type="text"
          placeholder="留空使用默认目录"
          value={whisperModelDir}
          onChange={(e) => setWhisperModelDir(e.target.value)}
          onBlur={() => configService.setWhisperModelDir(whisperModelDir)}
        />
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={handleSelectWhisperModelDir}><FolderOpen size={16} /> 选择目录</button>
          <button className="btn btn-secondary" onClick={handleResetWhisperModelDir}><RotateCcw size={16} /> 默认目录</button>
        </div>
        <div className="whisper-status-line">
          <span className={`status ${whisperModelStatus?.exists ? 'ok' : 'warn'}`}>
            {whisperModelStatus?.exists ? '已下载 (240 MB)' : '未下载 (240 MB)'}
          </span>
          {whisperModelStatus?.modelPath && <span className="path">{whisperModelStatus.modelPath}</span>}
        </div>
        {isWhisperDownloading ? (
          <div className="whisper-progress">
            <div className="progress-info">
              <span>正在准备模型文件...</span>
              <span className="percent">{whisperDownloadProgress.toFixed(0)}%</span>
            </div>
            <div className="progress-bar-container">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${whisperDownloadProgress}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <button className="btn btn-primary btn-download-model" onClick={handleDownloadWhisperModel}>
            <Download size={18} /> 下载模型
          </button>
        )}
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

  const getOptionLabel = (options: { value: string; label: string }[], value: string) => {
    return options.find((option) => option.value === value)?.label ?? value
  }

  const renderExportTab = () => {
    const exportExcelColumnsValue = exportDefaultExcelCompactColumns ? 'compact' : 'full'
    const exportFormatLabel = getOptionLabel(exportFormatOptions, exportDefaultFormat)
    const exportDateRangeLabel = getOptionLabel(exportDateRangeOptions, exportDefaultDateRange)
    const exportExcelColumnsLabel = getOptionLabel(exportExcelColumnOptions, exportExcelColumnsValue)

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

    </div>
    )
  }
  const renderCacheTab = () => (
    <div className="tab-content">
      <p className="section-desc">管理应用缓存数据</p>
      <div className="form-group">
        <label>缓存目录 <span className="optional">(可选)</span></label>
        <span className="form-hint">留空使用默认目录</span>
        <input type="text" placeholder="留空使用默认目录" value={cachePath} onChange={(e) => setCachePath(e.target.value)} />
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={handleSelectCachePath}><FolderOpen size={16} /> 浏览选择</button>
          <button className="btn btn-secondary" onClick={() => setCachePath('')}><RotateCcw size={16} /> 恢复默认</button>
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
        {activeTab === 'whisper' && renderWhisperTab()}
        {activeTab === 'export' && renderExportTab()}
        {activeTab === 'cache' && renderCacheTab()}
        {activeTab === 'about' && renderAboutTab()}
      </div>
    </div>
  )
}

export default SettingsPage
