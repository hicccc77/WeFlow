import { contextBridge, ipcRenderer } from 'electron'

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    clear: () => ipcRenderer.invoke('config:clear')
  },

  // 通知
  notification: {
    show: (data: any) => ipcRenderer.invoke('notification:show', data),
    close: () => ipcRenderer.invoke('notification:close'),
    click: (sessionId: string) => ipcRenderer.send('notification-clicked', sessionId),
    ready: () => ipcRenderer.send('notification:ready'),
    resize: (width: number, height: number) => ipcRenderer.send('notification:resize', { width, height }),
    onShow: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('notification:show', callback)
      return () => ipcRenderer.removeAllListeners('notification:show')
    }
  },

  // 认证
  auth: {
    hello: (message?: string) => ipcRenderer.invoke('auth:hello', message),
    verifyEnabled: () => ipcRenderer.invoke('auth:verifyEnabled'),
    unlock: (password: string) => ipcRenderer.invoke('auth:unlock', password),
    enableLock: (password: string) => ipcRenderer.invoke('auth:enableLock', password),
    disableLock: (password: string) => ipcRenderer.invoke('auth:disableLock', password),
    changePassword: (oldPassword: string, newPassword: string) => ipcRenderer.invoke('auth:changePassword', oldPassword, newPassword),
    setHelloSecret: (password: string) => ipcRenderer.invoke('auth:setHelloSecret', password),
    clearHelloSecret: () => ipcRenderer.invoke('auth:clearHelloSecret'),
    isLockMode: () => ipcRenderer.invoke('auth:isLockMode')
  },


  // 对话框
  dialog: {
    openFile: (options: any) => ipcRenderer.invoke('dialog:openFile', options),
    openDirectory: (options: any) => ipcRenderer.invoke('dialog:openDirectory', options),
    saveFile: (options: any) => ipcRenderer.invoke('dialog:saveFile', options)
  },

  // Shell
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },

  // App
  app: {
    getDownloadsPath: () => ipcRenderer.invoke('app:getDownloadsPath'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getLaunchAtStartupStatus: () => ipcRenderer.invoke('app:getLaunchAtStartupStatus'),
    setLaunchAtStartup: (enabled: boolean) => ipcRenderer.invoke('app:setLaunchAtStartup', enabled),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    downloadAndInstall: () => ipcRenderer.invoke('app:downloadAndInstall'),
    ignoreUpdate: (version: string) => ipcRenderer.invoke('app:ignoreUpdate', version),
    onDownloadProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('app:downloadProgress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('app:downloadProgress')
    },
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => {
      ipcRenderer.on('app:updateAvailable', (_, info) => callback(info))
      return () => ipcRenderer.removeAllListeners('app:updateAvailable')
    },
    checkWayland: () => ipcRenderer.invoke('app:checkWayland'),
  },

  // 日志
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    read: () => ipcRenderer.invoke('log:read'),
    clear: () => ipcRenderer.invoke('log:clear'),
    debug: (data: any) => ipcRenderer.send('log:debug', data)
  },

  diagnostics: {
    getExportCardLogs: (options?: { limit?: number }) =>
      ipcRenderer.invoke('diagnostics:getExportCardLogs', options),
    clearExportCardLogs: () =>
      ipcRenderer.invoke('diagnostics:clearExportCardLogs'),
    exportExportCardLogs: (payload: { filePath: string; frontendLogs?: unknown[] }) =>
      ipcRenderer.invoke('diagnostics:exportExportCardLogs', payload)
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeStateChanged: (callback: (isMaximized: boolean) => void) => {
      const listener = (_: unknown, isMaximized: boolean) => callback(isMaximized)
      ipcRenderer.on('window:maximizeStateChanged', listener)
      return () => ipcRenderer.removeListener('window:maximizeStateChanged', listener)
    },
    close: () => ipcRenderer.send('window:close'),
    onCloseConfirmRequested: (callback: (payload: { canMinimizeToTray: boolean }) => void) => {
      const listener = (_: unknown, payload: { canMinimizeToTray: boolean }) => callback(payload)
      ipcRenderer.on('window:confirmCloseRequested', listener)
      return () => ipcRenderer.removeListener('window:confirmCloseRequested', listener)
    },
    respondCloseConfirm: (action: 'tray' | 'quit' | 'cancel') =>
      ipcRenderer.invoke('window:respondCloseConfirm', action),
    openAgreementWindow: () => ipcRenderer.invoke('window:openAgreementWindow'),
    completeOnboarding: () => ipcRenderer.invoke('window:completeOnboarding'),
    openOnboardingWindow: () => ipcRenderer.invoke('window:openOnboardingWindow'),
    setTitleBarOverlay: (options: { symbolColor: string }) => ipcRenderer.send('window:setTitleBarOverlay', options),
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) =>
      ipcRenderer.invoke('window:openVideoPlayerWindow', videoPath, videoWidth, videoHeight),
    resizeToFitVideo: (videoWidth: number, videoHeight: number) =>
      ipcRenderer.invoke('window:resizeToFitVideo', videoWidth, videoHeight),
    openImageViewerWindow: (imagePath: string, liveVideoPath?: string) =>
      ipcRenderer.invoke('window:openImageViewerWindow', imagePath, liveVideoPath),
    openChatHistoryWindow: (sessionId: string, messageId: number) =>
      ipcRenderer.invoke('window:openChatHistoryWindow', sessionId, messageId),
    openChatHistoryPayloadWindow: (payload: { sessionId: string; title?: string; recordList: any[] }) =>
      ipcRenderer.invoke('window:openChatHistoryPayloadWindow', payload),
    getChatHistoryPayload: (payloadId: string) =>
      ipcRenderer.invoke('window:getChatHistoryPayload', payloadId),
    openSessionChatWindow: (
      sessionId: string,
      options?: {
        source?: 'chat' | 'export'
        initialDisplayName?: string
        initialAvatarUrl?: string
        initialContactType?: 'friend' | 'group' | 'official' | 'former_friend' | 'other'
      }
    ) =>
      ipcRenderer.invoke('window:openSessionChatWindow', sessionId, options)
  },

  // 数据库路径
  dbPath: {
    autoDetect: () => ipcRenderer.invoke('dbpath:autoDetect'),
    scanWxids: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxids', rootPath),
    scanWxidCandidates: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxidCandidates', rootPath),
    getDefault: () => ipcRenderer.invoke('dbpath:getDefault')
  },

  // WCDB 数据库
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:testConnection', dbPath, hexKey, wxid),
    open: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:open', dbPath, hexKey, wxid),
    close: () => ipcRenderer.invoke('wcdb:close'),

  },

  // 密钥获取
  key: {
    autoGetDbKey: () => ipcRenderer.invoke('key:autoGetDbKey'),
    autoGetImageKey: (manualDir?: string, wxid?: string) => ipcRenderer.invoke('key:autoGetImageKey', manualDir, wxid),
    scanImageKeyFromMemory: (userDir: string) => ipcRenderer.invoke('key:scanImageKeyFromMemory', userDir),
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => {
      ipcRenderer.on('key:dbKeyStatus', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('key:dbKeyStatus')
    },
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => {
      ipcRenderer.on('key:imageKeyStatus', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('key:imageKeyStatus')
    }
  },


  // 聊天
  chat: {
    connect: () => ipcRenderer.invoke('chat:connect'),
    getSessions: () => ipcRenderer.invoke('chat:getSessions'),
    getSessionStatuses: (usernames: string[]) => ipcRenderer.invoke('chat:getSessionStatuses', usernames),
    getExportTabCounts: () => ipcRenderer.invoke('chat:getExportTabCounts'),
    getContactTypeCounts: () => ipcRenderer.invoke('chat:getContactTypeCounts'),
    getSessionMessageCounts: (sessionIds: string[]) => ipcRenderer.invoke('chat:getSessionMessageCounts', sessionIds),
    enrichSessionsContactInfo: (
      usernames: string[],
      options?: { skipDisplayName?: boolean; onlyMissingAvatar?: boolean }
    ) => ipcRenderer.invoke('chat:enrichSessionsContactInfo', usernames, options),
    getMessages: (sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) =>
      ipcRenderer.invoke('chat:getMessages', sessionId, offset, limit, startTime, endTime, ascending),
    getLatestMessages: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke('chat:getLatestMessages', sessionId, limit),
    getNewMessages: (sessionId: string, minTime: number, limit?: number) =>
      ipcRenderer.invoke('chat:getNewMessages', sessionId, minTime, limit),
    getContact: (username: string) => ipcRenderer.invoke('chat:getContact', username),
    getContactAvatar: (username: string) => ipcRenderer.invoke('chat:getContactAvatar', username),
    updateMessage: (sessionId: string, localId: number, createTime: number, newContent: string) =>
      ipcRenderer.invoke('chat:updateMessage', sessionId, localId, createTime, newContent),
    deleteMessage: (sessionId: string, localId: number, createTime: number, dbPathHint?: string) =>
      ipcRenderer.invoke('chat:deleteMessage', sessionId, localId, createTime, dbPathHint),
    checkAntiRevokeTriggers: (sessionIds: string[]) =>
      ipcRenderer.invoke('chat:checkAntiRevokeTriggers', sessionIds),
    installAntiRevokeTriggers: (sessionIds: string[]) =>
      ipcRenderer.invoke('chat:installAntiRevokeTriggers', sessionIds),
    uninstallAntiRevokeTriggers: (sessionIds: string[]) =>
      ipcRenderer.invoke('chat:uninstallAntiRevokeTriggers', sessionIds),
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) =>
      ipcRenderer.invoke('chat:resolveTransferDisplayNames', chatroomId, payerUsername, receiverUsername),
    getMyAvatarUrl: () => ipcRenderer.invoke('chat:getMyAvatarUrl'),
    downloadEmoji: (cdnUrl: string, md5?: string) => ipcRenderer.invoke('chat:downloadEmoji', cdnUrl, md5),
    getCachedMessages: (sessionId: string) => ipcRenderer.invoke('chat:getCachedMessages', sessionId),
    clearCurrentAccountData: (options: { clearCache?: boolean; clearExports?: boolean }) =>
      ipcRenderer.invoke('chat:clearCurrentAccountData', options),
    close: () => ipcRenderer.invoke('chat:close'),
    getSessionDetail: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetail', sessionId),
    getSessionDetailFast: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetailFast', sessionId),
    getSessionDetailExtra: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetailExtra', sessionId),
    getExportSessionStats: (
      sessionIds: string[],
      options?: {
        includeRelations?: boolean
        forceRefresh?: boolean
        allowStaleCache?: boolean
        preferAccurateSpecialTypes?: boolean
        cacheOnly?: boolean
      }
    ) => ipcRenderer.invoke('chat:getExportSessionStats', sessionIds, options),
    getGroupMyMessageCountHint: (chatroomId: string) =>
      ipcRenderer.invoke('chat:getGroupMyMessageCountHint', chatroomId),
    getImageData: (sessionId: string, msgId: string) => ipcRenderer.invoke('chat:getImageData', sessionId, msgId),
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) =>
      ipcRenderer.invoke('chat:getVoiceData', sessionId, msgId, createTime, serverId),
    getAllVoiceMessages: (sessionId: string) => ipcRenderer.invoke('chat:getAllVoiceMessages', sessionId),
    getAllImageMessages: (sessionId: string) => ipcRenderer.invoke('chat:getAllImageMessages', sessionId),
    getMessageDates: (sessionId: string) => ipcRenderer.invoke('chat:getMessageDates', sessionId),
    getMessageDateCounts: (sessionId: string) => ipcRenderer.invoke('chat:getMessageDateCounts', sessionId),
    getResourceMessages: (options?: {
      sessionId?: string
      types?: Array<'image' | 'video' | 'voice' | 'file'>
      beginTimestamp?: number
      endTimestamp?: number
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke('chat:getResourceMessages', options),
    getMediaStream: (options?: {
      sessionId?: string
      mediaType?: 'image' | 'video' | 'all'
      beginTimestamp?: number
      endTimestamp?: number
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke('chat:getMediaStream', options),
    resolveVoiceCache: (sessionId: string, msgId: string) => ipcRenderer.invoke('chat:resolveVoiceCache', sessionId, msgId),
    getVoiceTranscript: (sessionId: string, msgId: string, createTime?: number) => ipcRenderer.invoke('chat:getVoiceTranscript', sessionId, msgId, createTime),
    onVoiceTranscriptPartial: (callback: (payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => void) => {
      const listener = (_: any, payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => callback(payload)
      ipcRenderer.on('chat:voiceTranscriptPartial', listener)
      return () => ipcRenderer.removeListener('chat:voiceTranscriptPartial', listener)
    },
    getContacts: (options?: { lite?: boolean }) => ipcRenderer.invoke('chat:getContacts', options),
    getMessage: (sessionId: string, localId: number) =>
      ipcRenderer.invoke('chat:getMessage', sessionId, localId),
    searchMessages: (keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number) =>
      ipcRenderer.invoke('chat:searchMessages', keyword, sessionId, limit, offset, beginTimestamp, endTimestamp),
    onWcdbChange: (callback: (event: any, data: { type: string; json: string }) => void) => {
      ipcRenderer.on('wcdb-change', callback)
      return () => ipcRenderer.removeListener('wcdb-change', callback)
    }
  },



  // 图片解密
  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) =>
      ipcRenderer.invoke('image:decrypt', payload),
    resolveCache: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; disableUpdateCheck?: boolean }) =>
      ipcRenderer.invoke('image:resolveCache', payload),
    resolveCacheBatch: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>,
      options?: { disableUpdateCheck?: boolean }
    ) => ipcRenderer.invoke('image:resolveCacheBatch', payloads, options),
    preload: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>,
      options?: { allowDecrypt?: boolean }
    ) => ipcRenderer.invoke('image:preload', payloads, options),
    onUpdateAvailable: (callback: (payload: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => {
      const listener = (_: unknown, payload: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => callback(payload)
      ipcRenderer.on('image:updateAvailable', listener)
      return () => ipcRenderer.removeListener('image:updateAvailable', listener)
    },
    onCacheResolved: (callback: (payload: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => {
      const listener = (_: unknown, payload: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => callback(payload)
      ipcRenderer.on('image:cacheResolved', listener)
      return () => ipcRenderer.removeListener('image:cacheResolved', listener)
    },
    onDecryptProgress: (callback: (payload: {
      cacheKey: string
      imageMd5?: string
      imageDatName?: string
      stage: 'queued' | 'locating' | 'decrypting' | 'writing' | 'done' | 'failed'
      progress: number
      status: 'running' | 'done' | 'error'
      message?: string
    }) => void) => {
      const listener = (_: unknown, payload: {
        cacheKey: string
        imageMd5?: string
        imageDatName?: string
        stage: 'queued' | 'locating' | 'decrypting' | 'writing' | 'done' | 'failed'
        progress: number
        status: 'running' | 'done' | 'error'
        message?: string
      }) => callback(payload)
      ipcRenderer.on('image:decryptProgress', listener)
      return () => ipcRenderer.removeListener('image:decryptProgress', listener)
    }
  },

  // 视频
  video: {
    getVideoInfo: (videoMd5: string, options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => ipcRenderer.invoke('video:getVideoInfo', videoMd5, options),
    parseVideoMd5: (content: string) => ipcRenderer.invoke('video:parseVideoMd5', content)
  },

  // 数据分析
  analytics: {
    getOverallStatistics: (force?: boolean) => ipcRenderer.invoke('analytics:getOverallStatistics', force),
    getContactRankings: (limit?: number, beginTimestamp?: number, endTimestamp?: number) =>
      ipcRenderer.invoke('analytics:getContactRankings', limit, beginTimestamp, endTimestamp),
    getTimeDistribution: () => ipcRenderer.invoke('analytics:getTimeDistribution'),
    getExcludedUsernames: () => ipcRenderer.invoke('analytics:getExcludedUsernames'),
    setExcludedUsernames: (usernames: string[]) => ipcRenderer.invoke('analytics:setExcludedUsernames', usernames),
    getExcludeCandidates: () => ipcRenderer.invoke('analytics:getExcludeCandidates'),
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => {
      ipcRenderer.on('analytics:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('analytics:progress')
    }
  },

  // 缓存管理
  cache: {
    clearAnalytics: () => ipcRenderer.invoke('cache:clearAnalytics'),
    clearImages: () => ipcRenderer.invoke('cache:clearImages'),
    clearAll: () => ipcRenderer.invoke('cache:clearAll')
  },

  // 群聊分析
  groupAnalytics: {
    getGroupChats: () => ipcRenderer.invoke('groupAnalytics:getGroupChats'),
    getGroupMembers: (chatroomId: string) => ipcRenderer.invoke('groupAnalytics:getGroupMembers', chatroomId),
    getGroupMembersPanelData: (
      chatroomId: string,
      options?: { forceRefresh?: boolean; includeMessageCounts?: boolean }
    ) => ipcRenderer.invoke('groupAnalytics:getGroupMembersPanelData', chatroomId, options),
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMessageRanking', chatroomId, limit, startTime, endTime),
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupActiveHours', chatroomId, startTime, endTime),
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMediaStats', chatroomId, startTime, endTime),
    getGroupMemberAnalytics: (chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMemberAnalytics', chatroomId, memberUsername, startTime, endTime),
    getGroupMemberMessages: (
      chatroomId: string,
      memberUsername: string,
      options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }
    ) => ipcRenderer.invoke('groupAnalytics:getGroupMemberMessages', chatroomId, memberUsername, options),
    exportGroupMembers: (chatroomId: string, outputPath: string) => ipcRenderer.invoke('groupAnalytics:exportGroupMembers', chatroomId, outputPath),
    exportGroupMemberMessages: (chatroomId: string, memberUsername: string, outputPath: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('groupAnalytics:exportGroupMemberMessages', chatroomId, memberUsername, outputPath, startTime, endTime)
  },

  // 年度报告
  annualReport: {
    getAvailableYears: () => ipcRenderer.invoke('annualReport:getAvailableYears'),
    startAvailableYearsLoad: () => ipcRenderer.invoke('annualReport:startAvailableYearsLoad'),
    cancelAvailableYearsLoad: (taskId: string) => ipcRenderer.invoke('annualReport:cancelAvailableYearsLoad', taskId),
    generateReport: (year: number) => ipcRenderer.invoke('annualReport:generateReport', year),
    exportImages: (payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) =>
      ipcRenderer.invoke('annualReport:exportImages', payload),
    onAvailableYearsProgress: (callback: (payload: {
      taskId: string
      years?: number[]
      done: boolean
      error?: string
      canceled?: boolean
      strategy?: 'cache' | 'native' | 'hybrid'
      phase?: 'cache' | 'native' | 'scan' | 'done'
      statusText?: string
      nativeElapsedMs?: number
      scanElapsedMs?: number
      totalElapsedMs?: number
      switched?: boolean
      nativeTimedOut?: boolean
    }) => void) => {
      ipcRenderer.on('annualReport:availableYearsProgress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('annualReport:availableYearsProgress')
    },
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => {
      ipcRenderer.on('annualReport:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('annualReport:progress')
    }
  },
  dualReport: {
    generateReport: (payload: { friendUsername: string; year: number }) =>
      ipcRenderer.invoke('dualReport:generateReport', payload),
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => {
      ipcRenderer.on('dualReport:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('dualReport:progress')
    }
  },

  // 导出
  export: {
    getExportStats: (sessionIds: string[], options: any) =>
      ipcRenderer.invoke('export:getExportStats', sessionIds, options),
    exportSessions: (sessionIds: string[], outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportSessions', sessionIds, outputDir, options),
    exportSession: (sessionId: string, outputPath: string, options: any) =>
      ipcRenderer.invoke('export:exportSession', sessionId, outputPath, options),
    exportContacts: (outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportContacts', outputDir, options),
    onProgress: (callback: (payload: {
      current: number
      total: number
      currentSession: string
      currentSessionId?: string
      phase: string
      phaseProgress?: number
      phaseTotal?: number
      phaseLabel?: string
      collectedMessages?: number
      exportedMessages?: number
      estimatedTotalMessages?: number
      writtenFiles?: number
    }) => void) => {
      ipcRenderer.on('export:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('export:progress')
    }
  },

  whisper: {
    downloadModel: () =>
      ipcRenderer.invoke('whisper:downloadModel'),
    getModelStatus: () =>
      ipcRenderer.invoke('whisper:getModelStatus'),
    onDownloadProgress: (callback: (payload: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => {
      ipcRenderer.on('whisper:downloadProgress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('whisper:downloadProgress')
    }
  },

  // 朋友圈
  sns: {
    getTimeline: (limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('sns:getTimeline', limit, offset, usernames, keyword, startTime, endTime),
    getSnsUsernames: () => ipcRenderer.invoke('sns:getSnsUsernames'),
    getUserPostCounts: () => ipcRenderer.invoke('sns:getUserPostCounts'),
    getExportStatsFast: () => ipcRenderer.invoke('sns:getExportStatsFast'),
    getExportStats: () => ipcRenderer.invoke('sns:getExportStats'),
    getUserPostStats: (username: string) => ipcRenderer.invoke('sns:getUserPostStats', username),
    debugResource: (url: string) => ipcRenderer.invoke('sns:debugResource', url),
    proxyImage: (payload: { url: string; key?: string | number }) => ipcRenderer.invoke('sns:proxyImage', payload),
    downloadImage: (payload: { url: string; key?: string | number }) => ipcRenderer.invoke('sns:downloadImage', payload),
    exportTimeline: (options: any) => ipcRenderer.invoke('sns:exportTimeline', options),
    onExportProgress: (callback: (payload: any) => void) => {
      ipcRenderer.on('sns:exportProgress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('sns:exportProgress')
    },
    selectExportDir: () => ipcRenderer.invoke('sns:selectExportDir'),
    installBlockDeleteTrigger: () => ipcRenderer.invoke('sns:installBlockDeleteTrigger'),
    uninstallBlockDeleteTrigger: () => ipcRenderer.invoke('sns:uninstallBlockDeleteTrigger'),
    checkBlockDeleteTrigger: () => ipcRenderer.invoke('sns:checkBlockDeleteTrigger'),
    deleteSnsPost: (postId: string) => ipcRenderer.invoke('sns:deleteSnsPost', postId),
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) => ipcRenderer.invoke('sns:downloadEmoji', params),
    getCacheMigrationStatus: () => ipcRenderer.invoke('sns:getCacheMigrationStatus'),
    startCacheMigration: () => ipcRenderer.invoke('sns:startCacheMigration'),
    onCacheMigrationProgress: (callback: (payload: any) => void) => {
      const listener = (_event: unknown, payload: any) => callback(payload)
      ipcRenderer.on('sns:cacheMigrationProgress', listener)
      return () => ipcRenderer.removeListener('sns:cacheMigrationProgress', listener)
    }
  },

  biz: {
    listAccounts: (account?: string) => ipcRenderer.invoke('biz:listAccounts', account),
    listMessages: (username: string, account?: string, limit?: number, offset?: number) =>
        ipcRenderer.invoke('biz:listMessages', username, account, limit, offset),
    listPayRecords: (account?: string, limit?: number, offset?: number) =>
        ipcRenderer.invoke('biz:listPayRecords', account, limit, offset)
  },


  // 数据收集
  cloud: {
    init: () => ipcRenderer.invoke('cloud:init'),
    recordPage: (pageName: string) => ipcRenderer.invoke('cloud:recordPage', pageName),
    getLogs: () => ipcRenderer.invoke('cloud:getLogs')
  },

  // HTTP API 服务
  http: {
    start: (port?: number, host?: string) => ipcRenderer.invoke('http:start', port, host),
    stop: () => ipcRenderer.invoke('http:stop'),
    status: () => ipcRenderer.invoke('http:status')
  }
})
