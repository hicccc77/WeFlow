import { create } from 'zustand'

export interface AppState {
  // 数据库状态
  isDbConnected: boolean
  dbPath: string | null
  myWxid: string | null
  
  // 加载状态
  isLoading: boolean
  loadingText: string
  
  // 操作
  setDbConnected: (connected: boolean, path?: string) => void
  setMyWxid: (wxid: string) => void
  setLoading: (loading: boolean, text?: string) => void
  reset: () => void
}

export const useAppStore = create<AppState>((set) => ({
  isDbConnected: false,
  dbPath: null,
  myWxid: null,
  isLoading: false,
  loadingText: '',

  setDbConnected: (connected, path) => set({ 
    isDbConnected: connected, 
    dbPath: path ?? null 
  }),
  
  setMyWxid: (wxid) => set({ myWxid: wxid }),
  
  setLoading: (loading, text) => set({ 
    isLoading: loading, 
    loadingText: text ?? '' 
  }),
  
  reset: () => set({
    isDbConnected: false,
    dbPath: null,
    myWxid: null,
    isLoading: false,
    loadingText: ''
  })
}))
