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
    hello: (message?: string) => ipcRenderer.invoke('auth:hello', message)
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
    }
  },

  // 日志
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    read: () => ipcRenderer.invoke('log:read'),
    debug: (data: any) => ipcRenderer.send('log:debug', data)
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    openAgreementWindow: () => ipcRenderer.invoke('window:openAgreementWindow'),
    completeOnboarding: () => ipcRenderer.invoke('window:completeOnboarding'),
    openOnboardingWindow: () => ipcRenderer.invoke('window:openOnboardingWindow'),
    setTitleBarOverlay: (options: { symbolColor: string }) => ipcRenderer.send('window:setTitleBarOverlay', options),
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) =>
      ipcRenderer.invoke('window:openVideoPlayerWindow', videoPath, videoWidth, videoHeight),
    resizeToFitVideo: (videoWidth: number, videoHeight: number) =>
      ipcRenderer.invoke('window:resizeToFitVideo', videoWidth, videoHeight),
    openImageViewerWindow: (imagePath: string) =>
      ipcRenderer.invoke('window:openImageViewerWindow', imagePath),
    openChatHistoryWindow: (sessionId: string, messageId: number) =>
      ipcRenderer.invoke('window:openChatHistoryWindow', sessionId, messageId)
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
    autoGetImageKey: (manualDir?: string) => ipcRenderer.invoke('key:autoGetImageKey', manualDir),
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
    enrichSessionsContactInfo: (usernames: string[]) =>
      ipcRenderer.invoke('chat:enrichSessionsContactInfo', usernames),
    getMessages: (sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) =>
      ipcRenderer.invoke('chat:getMessages', sessionId, offset, limit, startTime, endTime, ascending),
    getLatestMessages: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke('chat:getLatestMessages', sessionId, limit),
    getNewMessages: (sessionId: string, minTime: number, limit?: number) =>
      ipcRenderer.invoke('chat:getNewMessages', sessionId, minTime, limit),
    getContact: (username: string) => ipcRenderer.invoke('chat:getContact', username),
    getContactAvatar: (username: string) => ipcRenderer.invoke('chat:getContactAvatar', username),
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) =>
      ipcRenderer.invoke('chat:resolveTransferDisplayNames', chatroomId, payerUsername, receiverUsername),
    getMyAvatarUrl: () => ipcRenderer.invoke('chat:getMyAvatarUrl'),
    downloadEmoji: (cdnUrl: string, md5?: string) => ipcRenderer.invoke('chat:downloadEmoji', cdnUrl, md5),
    getCachedMessages: (sessionId: string) => ipcRenderer.invoke('chat:getCachedMessages', sessionId),
    close: () => ipcRenderer.invoke('chat:close'),
    getSessionDetail: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetail', sessionId),
    getImageData: (sessionId: string, msgId: string) => ipcRenderer.invoke('chat:getImageData', sessionId, msgId),
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) =>
      ipcRenderer.invoke('chat:getVoiceData', sessionId, msgId, createTime, serverId),
    getAllVoiceMessages: (sessionId: string) => ipcRenderer.invoke('chat:getAllVoiceMessages', sessionId),
    resolveVoiceCache: (sessionId: string, msgId: string) => ipcRenderer.invoke('chat:resolveVoiceCache', sessionId, msgId),
    getVoiceTranscript: (sessionId: string, msgId: string, createTime?: number) => ipcRenderer.invoke('chat:getVoiceTranscript', sessionId, msgId, createTime),
    onVoiceTranscriptPartial: (callback: (payload: { msgId: string; text: string }) => void) => {
      const listener = (_: any, payload: { msgId: string; text: string }) => callback(payload)
      ipcRenderer.on('chat:voiceTranscriptPartial', listener)
      return () => ipcRenderer.removeListener('chat:voiceTranscriptPartial', listener)
    },
    execQuery: (kind: string, path: string | null, sql: string) =>
      ipcRenderer.invoke('chat:execQuery', kind, path, sql),
    getContacts: () => ipcRenderer.invoke('chat:getContacts'),
    getMessage: (sessionId: string, localId: number) =>
      ipcRenderer.invoke('chat:getMessage', sessionId, localId),
    onWcdbChange: (callback: (event: any, data: { type: string; json: string }) => void) => {
      ipcRenderer.on('wcdb-change', callback)
      return () => ipcRenderer.removeListener('wcdb-change', callback)
    }
  },



  // 图片解密
  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) =>
      ipcRenderer.invoke('image:decrypt', payload),
    resolveCache: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }) =>
      ipcRenderer.invoke('image:resolveCache', payload),
    preload: (payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>) =>
      ipcRenderer.invoke('image:preload', payloads),
    onUpdateAvailable: (callback: (payload: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => {
      ipcRenderer.on('image:updateAvailable', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('image:updateAvailable')
    },
    onCacheResolved: (callback: (payload: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => {
      ipcRenderer.on('image:cacheResolved', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('image:cacheResolved')
    }
  },

  // 视频
  video: {
    getVideoInfo: (videoMd5: string) => ipcRenderer.invoke('video:getVideoInfo', videoMd5),
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
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMessageRanking', chatroomId, limit, startTime, endTime),
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupActiveHours', chatroomId, startTime, endTime),
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMediaStats', chatroomId, startTime, endTime),
    exportGroupMembers: (chatroomId: string, outputPath: string) => ipcRenderer.invoke('groupAnalytics:exportGroupMembers', chatroomId, outputPath)
  },

  // 年度报告
  annualReport: {
    getAvailableYears: () => ipcRenderer.invoke('annualReport:getAvailableYears'),
    generateReport: (year: number) => ipcRenderer.invoke('annualReport:generateReport', year),
    exportImages: (payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) =>
      ipcRenderer.invoke('annualReport:exportImages', payload),
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
    onProgress: (callback: (payload: { current: number; total: number; currentSession: string; phase: string }) => void) => {
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
    debugResource: (url: string) => ipcRenderer.invoke('sns:debugResource', url),
    proxyImage: (url: string) => ipcRenderer.invoke('sns:proxyImage', url)
  },

  // Llama AI
  llama: {
    loadModel: (modelPath: string) => ipcRenderer.invoke('llama:loadModel', modelPath),
    createSession: (systemPrompt?: string) => ipcRenderer.invoke('llama:createSession', systemPrompt),
    chat: (message: string, options?: any) => ipcRenderer.invoke('llama:chat', message, options),
    downloadModel: (url: string, savePath: string) => ipcRenderer.invoke('llama:downloadModel', url, savePath),
    getModelsPath: () => ipcRenderer.invoke('llama:getModelsPath'),
    checkFileExists: (filePath: string) => ipcRenderer.invoke('llama:checkFileExists', filePath),
    getModelStatus: (modelPath: string) => ipcRenderer.invoke('llama:getModelStatus', modelPath),
    onToken: (callback: (token: string) => void) => {
      const listener = (_: any, token: string) => callback(token)
      ipcRenderer.on('llama:token', listener)
      return () => ipcRenderer.removeListener('llama:token', listener)
    },
    onDownloadProgress: (callback: (payload: { downloaded: number; total: number; speed: number }) => void) => {
      const listener = (_: any, payload: { downloaded: number; total: number; speed: number }) => callback(payload)
      ipcRenderer.on('llama:downloadProgress', listener)
      return () => ipcRenderer.removeListener('llama:downloadProgress', listener)
    }
  },

  // HTTP API 服务
  http: {
    start: (port?: number) => ipcRenderer.invoke('http:start', port),
    stop: () => ipcRenderer.invoke('http:stop'),
    status: () => ipcRenderer.invoke('http:status')
  }
})
