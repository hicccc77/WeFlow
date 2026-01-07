import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeId = 'cloud-dancer' | 'corundum-blue' | 'kiwi-green' | 'spicy-red' | 'teal-water'
export type ThemeMode = 'light' | 'dark'

export interface ThemeInfo {
  id: ThemeId
  name: string
  description: string
  primaryColor: string
  bgColor: string
}

export const themes: ThemeInfo[] = [
  {
    id: 'cloud-dancer',
    name: '云上舞白',
    description: 'Pantone 2026 年度色',
    primaryColor: '#8B7355',
    bgColor: '#F0EEE9'
  },
  {
    id: 'corundum-blue',
    name: '刚玉蓝',
    description: 'RAL 220 40 10',
    primaryColor: '#4A6670',
    bgColor: '#E8EEF0'
  },
  {
    id: 'kiwi-green',
    name: '冰猕猴桃汁绿',
    description: 'RAL 120 90 20',
    primaryColor: '#7A9A5C',
    bgColor: '#E8F0E4'
  },
  {
    id: 'spicy-red',
    name: '辛辣红',
    description: 'RAL 030 40 40',
    primaryColor: '#8B4049',
    bgColor: '#F0E8E8'
  },
  {
    id: 'teal-water',
    name: '明水鸭色',
    description: 'RAL 180 80 10',
    primaryColor: '#5A8A8A',
    bgColor: '#E4F0F0'
  }
]

interface ThemeState {
  currentTheme: ThemeId
  themeMode: ThemeMode
  setTheme: (theme: ThemeId) => void
  setThemeMode: (mode: ThemeMode) => void
  toggleThemeMode: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      currentTheme: 'cloud-dancer',
      themeMode: 'light',
      setTheme: (theme) => set({ currentTheme: theme }),
      setThemeMode: (mode) => set({ themeMode: mode }),
      toggleThemeMode: () => set({ themeMode: get().themeMode === 'light' ? 'dark' : 'light' })
    }),
    {
      name: 'echotrace-theme'
    }
  )
)

// 获取当前主题信息
export const getThemeInfo = (themeId: ThemeId): ThemeInfo => {
  return themes.find(t => t.id === themeId) || themes[0]
}
