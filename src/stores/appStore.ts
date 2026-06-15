import { create } from 'zustand'

export interface AppState {
  // 数据库状态
  isDbConnected: boolean
  dbPath: string | null
  myWxid: string | null

  // 加载状态
  isLoading: boolean
  loadingText: string

  // 更新状态
  updateInfo: {
    hasUpdate: boolean
    version?: string
    releaseNotes?: string
  } | null
  isDownloading: boolean
  downloadProgress: any
  showUpdateDialog: boolean
  updateError: string | null

  // 操作
  setDbConnected: (connected: boolean, path?: string) => void
  setMyWxid: (wxid: string) => void
  setLoading: (loading: boolean, text?: string) => void

  // 更新操作
  setUpdateInfo: (info: any) => void
  setIsDownloading: (isDownloading: boolean) => void
  setDownloadProgress: (progress: any) => void
  setShowUpdateDialog: (show: boolean) => void
  setUpdateError: (error: string | null) => void

  // 锁定状态
  isLocked: boolean
  setLocked: (locked: boolean) => void

  reset: () => void
}

export const useAppStore = create<AppState>((set) => ({
  isDbConnected: false,
  dbPath: null,
  myWxid: null,
  isLoading: false,
  loadingText: '',
  isLocked: false,

  // 更新状态初始化
  updateInfo: null,
  isDownloading: false,
  downloadProgress: { percent: 0 },
  showUpdateDialog: false,
  updateError: null,

  setDbConnected: (connected, path) => set({
    isDbConnected: connected,
    dbPath: path ?? null
  }),

  setMyWxid: (wxid) => set({ myWxid: wxid }),

  setLoading: (loading, text) => set({
    isLoading: loading,
    loadingText: text ?? ''
  }),

  setLocked: (locked) => set({ isLocked: locked }),

  setUpdateInfo: (info) => set({ updateInfo: info, updateError: null }),
  setIsDownloading: (isDownloading) => set({ isDownloading: isDownloading }),
  setDownloadProgress: (progress) => set({ downloadProgress: progress }),
  setShowUpdateDialog: (show) => set({ showUpdateDialog: show }),
  setUpdateError: (error) => set({ updateError: error }),

  reset: () => set({
    isDbConnected: false,
    dbPath: null,
    myWxid: null,
    isLoading: false,
    loadingText: '',
    isLocked: false,
    updateInfo: null,
    isDownloading: false,
    downloadProgress: { percent: 0 },
    showUpdateDialog: false,
    updateError: null
  })
}))
