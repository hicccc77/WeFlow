import type { ChatSession, Message, Contact } from './models'

export interface ElectronAPI {
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    openAgreementWindow: () => Promise<boolean>
    setTitleBarOverlay: (options: { symbolColor: string }) => void
  }
  config: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  dialog: {
    openFile: (options?: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
    saveFile: (options?: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
  }
  shell: {
    openPath: (path: string) => Promise<string>
    openExternal: (url: string) => Promise<void>
  }
  app: {
    getDownloadsPath: () => Promise<string>
    getVersion: () => Promise<string>
    checkForUpdates: () => Promise<{ hasUpdate: boolean; version?: string; releaseNotes?: string }>
    downloadAndInstall: () => Promise<void>
    onDownloadProgress: (callback: (progress: number) => void) => () => void
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => () => void
  }
  log: {
    getPath: () => Promise<string>
    read: () => Promise<{ success: boolean; content?: string; error?: string }>
  }
  dbPath: {
    autoDetect: () => Promise<{ success: boolean; path?: string; error?: string }>
    scanWxids: (rootPath: string) => Promise<string[]>
    getDefault: () => Promise<string>
  }
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) => Promise<{ success: boolean; error?: string; sessionCount?: number }>
    open: (dbPath: string, hexKey: string, wxid: string) => Promise<boolean>
    close: () => Promise<boolean>
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    getSessions: () => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
    getMessages: (sessionId: string, offset?: number, limit?: number) => Promise<{ 
      success: boolean; 
      messages?: Message[]; 
      hasMore?: boolean; 
      error?: string 
    }>
    getContact: (username: string) => Promise<Contact | null>
    getContactAvatar: (username: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
    getMyAvatarUrl: () => Promise<{ success: boolean; avatarUrl?: string; error?: string }>
    downloadEmoji: (cdnUrl: string, md5?: string) => Promise<{ success: boolean; localPath?: string; error?: string }>
    close: () => Promise<boolean>
    getSessionDetail: (sessionId: string) => Promise<{
      success: boolean
      detail?: {
        wxid: string
        displayName: string
        remark?: string
        nickName?: string
        alias?: string
        avatarUrl?: string
        messageCount: number
        firstMessageTime?: number
        latestMessageTime?: number
        messageTables: { dbName: string; tableName: string; count: number }[]
      }
      error?: string
    }>
  }
  analytics: {
    getOverallStatistics: () => Promise<{ 
      success: boolean
      data?: {
        totalMessages: number
        textMessages: number
        imageMessages: number
        voiceMessages: number
        videoMessages: number
        emojiMessages: number
        otherMessages: number
        sentMessages: number
        receivedMessages: number
        firstMessageTime: number | null
        lastMessageTime: number | null
        activeDays: number
        messageTypeCounts: Record<number, number>
      }
      error?: string 
    }>
    getContactRankings: (limit?: number) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        messageCount: number
        sentCount: number
        receivedCount: number
        lastMessageTime: number | null
      }>
      error?: string
    }>
    getTimeDistribution: () => Promise<{
      success: boolean
      data?: {
        hourlyDistribution: Record<number, number>
        weekdayDistribution: Record<number, number>
        monthlyDistribution: Record<string, number>
      }
      error?: string
    }>
  }
  groupAnalytics: {
    getGroupChats: () => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        memberCount: number
        avatarUrl?: string
      }>
      error?: string
    }>
    getGroupMembers: (chatroomId: string) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
      }>
      error?: string
    }>
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: Array<{
        member: {
          username: string
          displayName: string
          avatarUrl?: string
        }
        messageCount: number
      }>
      error?: string
    }>
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: {
        hourlyDistribution: Record<number, number>
      }
      error?: string
    }>
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: {
        typeCounts: Array<{
          type: number
          name: string
          count: number
        }>
        total: number
      }
      error?: string
    }>
  }
  annualReport: {
    getAvailableYears: () => Promise<{
      success: boolean
      data?: number[]
      error?: string
    }>
    generateReport: (year: number) => Promise<{
      success: boolean
      data?: {
        year: number
        totalMessages: number
        totalFriends: number
        coreFriends: Array<{
          username: string
          displayName: string
          avatarUrl?: string
          messageCount: number
          sentCount: number
          receivedCount: number
        }>
        monthlyTopFriends: Array<{
          month: number
          displayName: string
          avatarUrl?: string
          messageCount: number
        }>
        peakDay: {
          date: string
          messageCount: number
          topFriend?: string
          topFriendCount?: number
        } | null
        longestStreak: {
          friendName: string
          days: number
          startDate: string
          endDate: string
        } | null
        activityHeatmap: {
          data: number[][]
        }
        midnightKing: {
          displayName: string
          count: number
          percentage: number
        } | null
        selfAvatarUrl?: string
        mutualFriend: {
          displayName: string
          avatarUrl?: string
          sentCount: number
          receivedCount: number
          ratio: number
        } | null
        socialInitiative: {
          initiatedChats: number
          receivedChats: number
          initiativeRate: number
        } | null
        responseSpeed: {
          avgResponseTime: number
          fastestFriend: string
          fastestTime: number
        } | null
        topPhrases: Array<{
          phrase: string
          count: number
        }>
      }
      error?: string
    }>
  }
  export: {
    exportSessions: (sessionIds: string[], outputDir: string, options: ExportOptions) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
    }>
    exportSession: (sessionId: string, outputPath: string, options: ExportOptions) => Promise<{
      success: boolean
      error?: string
    }>
  }
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
  
  // Electron 类型声明
  namespace Electron {
    interface OpenDialogOptions {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
      properties?: ('openFile' | 'openDirectory' | 'multiSelections')[]
    }
    interface OpenDialogReturnValue {
      canceled: boolean
      filePaths: string[]
    }
    interface SaveDialogOptions {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }
    interface SaveDialogReturnValue {
      canceled: boolean
      filePath?: string
    }
  }
}

export {}
