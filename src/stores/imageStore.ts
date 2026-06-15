import { create } from 'zustand'

export interface ImageFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  isDecrypted: boolean
  decryptedPath?: string
  version: number
  isDecrypting?: boolean
}

export interface ImageDirectory {
  wxid: string
  path: string
}

/**
 * 检测图片质量（原图/缩略图）
 * 逻辑来自原项目 app_state.dart 的 _detectImageQuality
 */
function detectImageQuality(img: ImageFileInfo): 'original' | 'thumbnail' {
  const fileNameLower = img.fileName.toLowerCase()
  const fileSize = img.fileSize

  // 小于 50KB 是缩略图
  if (fileSize < 50 * 1024) return 'thumbnail'
  // 大于 500KB 是原图
  if (fileSize > 500 * 1024) return 'original'

  // 文件名包含 thumb/small 关键词
  if (fileNameLower.includes('thumb') || fileNameLower.includes('small')) {
    return 'thumbnail'
  }

  // 文件名以 _thumb.dat 或 _small.dat 结尾
  if (fileNameLower.endsWith('_thumb.dat') || fileNameLower.endsWith('_small.dat')) {
    return 'thumbnail'
  }

  // 路径层级判断（通过 filePath 中的分隔符数量）
  const pathParts = img.filePath.split(/[/\\]/)
  // 找到账号目录后的相对路径层级
  // 如果层级太深，可能是缩略图
  if (pathParts.length > 10) return 'thumbnail'

  return 'original'
}

interface ImageState {
  // 图片列表
  images: ImageFileInfo[]
  // 目录列表
  directories: ImageDirectory[]
  // 当前选中的目录
  selectedDir: ImageDirectory | null
  // 扫描状态
  isScanning: boolean
  scanCompleted: boolean
  // 错误信息
  error: string | null
  
  // 统计
  originalCount: number
  thumbnailCount: number
  decryptedCount: number
  
  // 操作
  setDirectories: (dirs: ImageDirectory[]) => void
  setSelectedDir: (dir: ImageDirectory | null) => void
  setScanning: (scanning: boolean) => void
  setScanCompleted: (completed: boolean) => void
  setError: (error: string | null) => void
  addImages: (newImages: ImageFileInfo[]) => void
  clearImages: () => void
  updateImage: (index: number, updates: Partial<ImageFileInfo>) => void
  updateStats: () => void
  reset: () => void
}

export const useImageStore = create<ImageState>((set, get) => ({
  images: [],
  directories: [],
  selectedDir: null,
  isScanning: false,
  scanCompleted: false,
  error: null,
  originalCount: 0,
  thumbnailCount: 0,
  decryptedCount: 0,

  setDirectories: (dirs) => set({ directories: dirs }),
  
  setSelectedDir: (dir) => set({ selectedDir: dir }),
  
  setScanning: (scanning) => set({ isScanning: scanning }),
  
  setScanCompleted: (completed) => set({ scanCompleted: completed }),
  
  setError: (error) => set({ error }),
  
  addImages: (newImages) => {
    set((state) => {
      const updated = [...state.images, ...newImages]
      // 计算统计
      let original = 0
      let thumbnail = 0
      let decrypted = 0
      for (const img of updated) {
        if (detectImageQuality(img) === 'original') {
          original++
        } else {
          thumbnail++
        }
        if (img.isDecrypted) decrypted++
      }
      return {
        images: updated,
        originalCount: original,
        thumbnailCount: thumbnail,
        decryptedCount: decrypted
      }
    })
  },
  
  clearImages: () => set({ 
    images: [], 
    originalCount: 0, 
    thumbnailCount: 0, 
    decryptedCount: 0,
    scanCompleted: false 
  }),
  
  updateImage: (index, updates) => {
    set((state) => {
      const images = [...state.images]
      if (index >= 0 && index < images.length) {
        images[index] = { ...images[index], ...updates }
      }
      // 重新计算已解密数量
      const decryptedCount = images.filter(img => img.isDecrypted).length
      return { images, decryptedCount }
    })
  },
  
  updateStats: () => {
    const { images } = get()
    let original = 0
    let thumbnail = 0
    let decrypted = 0
    for (const img of images) {
      if (detectImageQuality(img) === 'original') {
        original++
      } else {
        thumbnail++
      }
      if (img.isDecrypted) decrypted++
    }
    set({ originalCount: original, thumbnailCount: thumbnail, decryptedCount: decrypted })
  },
  
  reset: () => set({
    images: [],
    directories: [],
    selectedDir: null,
    isScanning: false,
    scanCompleted: false,
    error: null,
    originalCount: 0,
    thumbnailCount: 0,
    decryptedCount: 0
  })
}))
