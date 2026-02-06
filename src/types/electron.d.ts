import type { ChatSession, Message, Contact, ContactInfo } from './models'

export interface ElectronAPI {
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    openAgreementWindow: () => Promise<boolean>
    completeOnboarding: () => Promise<boolean>
    openOnboardingWindow: () => Promise<boolean>
    setTitleBarOverlay: (options: { symbolColor: string }) => void
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => Promise<void>
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => Promise<void>
    openImageViewerWindow: (imagePath: string) => Promise<void>
    openChatHistoryWindow: (sessionId: string, messageId: number) => Promise<boolean>
  }
  config: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    clear: () => Promise<boolean>
  }
  dialog: {
    openFile: (options?: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
    openDirectory: (options?: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
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
    ignoreUpdate: (version: string) => Promise<{ success: boolean }>
    onDownloadProgress: (callback: (progress: number) => void) => () => void
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => () => void
  }
  log: {
    getPath: () => Promise<string>
    read: () => Promise<{ success: boolean; content?: string; error?: string }>
  }
  dbPath: {
    autoDetect: () => Promise<{ success: boolean; path?: string; error?: string }>
    scanWxids: (rootPath: string) => Promise<WxidInfo[]>
    scanWxidCandidates: (rootPath: string) => Promise<WxidInfo[]>
    getDefault: () => Promise<string>
  }
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) => Promise<{ success: boolean; error?: string; sessionCount?: number }>
    open: (dbPath: string, hexKey: string, wxid: string) => Promise<boolean>
    close: () => Promise<boolean>

  }
  key: {
    autoGetDbKey: () => Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }>
    autoGetImageKey: (manualDir?: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => () => void
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => () => void
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    getSessions: () => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
    enrichSessionsContactInfo: (usernames: string[]) => Promise<{
      success: boolean
      contacts?: Record<string, { displayName?: string; avatarUrl?: string }>
      error?: string
    }>
    getMessages: (sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      error?: string
    }>
    getLatestMessages: (sessionId: string, limit?: number) => Promise<{
      success: boolean
      messages?: Message[]
      error?: string
    }>
    getNewMessages: (sessionId: string, minTime: number, limit?: number) => Promise<{
      success: boolean
      messages?: Message[]
      error?: string
    }>
    getContact: (username: string) => Promise<Contact | null>
    getContactAvatar: (username: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
    getContacts: () => Promise<{
      success: boolean
      contacts?: ContactInfo[]
      error?: string
    }>
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
    getImageData: (sessionId: string, msgId: string) => Promise<{ success: boolean; data?: string; error?: string }>
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => Promise<{ success: boolean; data?: string; error?: string }>
    getAllVoiceMessages: (sessionId: string) => Promise<{ success: boolean; messages?: Message[]; error?: string }>
    resolveVoiceCache: (sessionId: string, msgId: string) => Promise<{ success: boolean; hasCache: boolean; data?: string }>
    getVoiceTranscript: (sessionId: string, msgId: string, createTime?: number) => Promise<{ success: boolean; transcript?: string; error?: string }>
    onVoiceTranscriptPartial: (callback: (payload: { msgId: string; text: string }) => void) => () => void
    execQuery: (kind: string, path: string | null, sql: string) => Promise<{ success: boolean; rows?: any[]; error?: string }>
    getMessage: (sessionId: string, localId: number) => Promise<{ success: boolean; message?: Message; error?: string }>
    onWcdbChange: (callback: (event: any, data: { type: string; json: string }) => void) => () => void
  }

  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) => Promise<{ success: boolean; localPath?: string; error?: string }>
    resolveCache: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }) => Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }>
    preload: (payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>) => Promise<boolean>
    onUpdateAvailable: (callback: (payload: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => () => void
    onCacheResolved: (callback: (payload: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => () => void
  }
  video: {
    getVideoInfo: (videoMd5: string) => Promise<{
      success: boolean
      exists: boolean
      videoUrl?: string
      coverUrl?: string
      thumbUrl?: string
      error?: string
    }>
    parseVideoMd5: (content: string) => Promise<{
      success: boolean
      md5?: string
      error?: string
    }>
  }
  analytics: {
    getOverallStatistics: (force?: boolean) => Promise<{
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
    getExcludedUsernames: () => Promise<{
      success: boolean
      data?: string[]
      error?: string
    }>
    setExcludedUsernames: (usernames: string[]) => Promise<{
      success: boolean
      data?: string[]
      error?: string
    }>
    getExcludeCandidates: () => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        wechatId?: string
      }>
      error?: string
    }>
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => () => void
  }
  cache: {
    clearAnalytics: () => Promise<{ success: boolean; error?: string }>
    clearImages: () => Promise<{ success: boolean; error?: string }>
    clearAll: () => Promise<{ success: boolean; error?: string }>
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
        nickname?: string
        alias?: string
        remark?: string
        groupNickname?: string
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
    exportGroupMembers: (chatroomId: string, outputPath: string) => Promise<{
      success: boolean
      count?: number
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
    exportImages: (payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) => Promise<{
      success: boolean
      dir?: string
      error?: string
    }>
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => () => void
  }
  dualReport: {
    generateReport: (payload: { friendUsername: string; year: number }) => Promise<{
      success: boolean
      data?: {
        year: number
        selfName: string
        friendUsername: string
        friendName: string
        firstChat: {
          createTime: number
          createTimeStr: string
          content: string
          isSentByMe: boolean
          senderUsername?: string
        } | null
        firstChatMessages?: Array<{
          content: string
          isSentByMe: boolean
          createTime: number
          createTimeStr: string
        }>
        yearFirstChat?: {
          createTime: number
          createTimeStr: string
          content: string
          isSentByMe: boolean
          friendName: string
          firstThreeMessages: Array<{
            content: string
            isSentByMe: boolean
            createTime: number
            createTimeStr: string
          }>
        } | null
        stats: {
          totalMessages: number
          totalWords: number
          imageCount: number
          voiceCount: number
          emojiCount: number
          myTopEmojiMd5?: string
          friendTopEmojiMd5?: string
          myTopEmojiUrl?: string
          friendTopEmojiUrl?: string
        }
        topPhrases: Array<{ phrase: string; count: number }>
      }
      error?: string
    }>
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => () => void
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
    exportContacts: (outputDir: string, options: { format: 'json' | 'csv' | 'vcf'; exportAvatars: boolean; contactTypes: { friends: boolean; groups: boolean; officials: boolean } }) => Promise<{
      success: boolean
      successCount?: number
      error?: string
    }>
    onProgress: (callback: (payload: ExportProgress) => void) => () => void
  }
  whisper: {
    downloadModel: () => Promise<{ success: boolean; modelPath?: string; tokensPath?: string; error?: string }>
    getModelStatus: () => Promise<{ success: boolean; exists?: boolean; modelPath?: string; tokensPath?: string; sizeBytes?: number; error?: string }>
    onDownloadProgress: (callback: (payload: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => () => void
  }
  sns: {
    getTimeline: (limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      timeline?: Array<{
        id: string
        username: string
        nickname: string
        avatarUrl?: string
        createTime: number
        contentDesc: string
        type?: number
        media: Array<{
          url: string
          thumb: string
          md5?: string
          token?: string
          key?: string
          encIdx?: string
          livePhoto?: {
            url: string
            thumb: string
            md5?: string
            token?: string
            key?: string
            encIdx?: string
          }
        }>
        likes: Array<string>
        comments: Array<{ id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }>
        rawXml?: string
      }>
      error?: string
    }>
    debugResource: (url: string) => Promise<{ success: boolean; status?: number; headers?: any; error?: string }>
    proxyImage: (url: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
  }
  llama: {
    loadModel: (modelPath: string) => Promise<boolean>
    createSession: (systemPrompt?: string) => Promise<boolean>
    chat: (message: string) => Promise<{ success: boolean; response?: any; error?: string }>
    downloadModel: (url: string, savePath: string) => Promise<void>
    getModelsPath: () => Promise<string>
    checkFileExists: (filePath: string) => Promise<boolean>
    getModelStatus: (modelPath: string) => Promise<{ exists: boolean; path?: string; size?: number; error?: string }>
    onToken: (callback: (token: string) => void) => () => void
    onDownloadProgress: (callback: (payload: { downloaded: number; total: number; speed: number }) => void) => () => void
  }
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportEmojis?: boolean
  exportVoiceAsText?: boolean
  excelCompactColumns?: boolean
  txtColumns?: string[]
  sessionLayout?: 'shared' | 'per-session'
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  phase: 'preparing' | 'exporting' | 'writing' | 'complete'
}

export interface WxidInfo {
  wxid: string
  modifiedTime: number
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
      properties?: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[]
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

export { }
