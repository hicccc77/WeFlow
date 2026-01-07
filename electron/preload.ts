import { contextBridge, ipcRenderer } from 'electron'

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value)
  },


  // 对话框
  dialog: {
    openFile: (options: any) => ipcRenderer.invoke('dialog:openFile', options),
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
    onDownloadProgress: (callback: (progress: number) => void) => {
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
    read: () => ipcRenderer.invoke('log:read')
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    openAgreementWindow: () => ipcRenderer.invoke('window:openAgreementWindow'),
    setTitleBarOverlay: (options: { symbolColor: string }) => ipcRenderer.send('window:setTitleBarOverlay', options)
  },

  // 数据库路径
  dbPath: {
    autoDetect: () => ipcRenderer.invoke('dbpath:autoDetect'),
    scanWxids: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxids', rootPath),
    getDefault: () => ipcRenderer.invoke('dbpath:getDefault')
  },

  // WCDB 数据库
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) => 
      ipcRenderer.invoke('wcdb:testConnection', dbPath, hexKey, wxid),
    open: (dbPath: string, hexKey: string, wxid: string) => 
      ipcRenderer.invoke('wcdb:open', dbPath, hexKey, wxid),
    close: () => ipcRenderer.invoke('wcdb:close')
  },


  // 聊天
  chat: {
    connect: () => ipcRenderer.invoke('chat:connect'),
    getSessions: () => ipcRenderer.invoke('chat:getSessions'),
    getMessages: (sessionId: string, offset?: number, limit?: number) => 
      ipcRenderer.invoke('chat:getMessages', sessionId, offset, limit),
    getContact: (username: string) => ipcRenderer.invoke('chat:getContact', username),
    getContactAvatar: (username: string) => ipcRenderer.invoke('chat:getContactAvatar', username),
    getMyAvatarUrl: () => ipcRenderer.invoke('chat:getMyAvatarUrl'),
    downloadEmoji: (cdnUrl: string, md5?: string) => ipcRenderer.invoke('chat:downloadEmoji', cdnUrl, md5),
    close: () => ipcRenderer.invoke('chat:close'),
    getSessionDetail: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetail', sessionId)
  },

  // 数据分析
  analytics: {
    getOverallStatistics: () => ipcRenderer.invoke('analytics:getOverallStatistics'),
    getContactRankings: (limit?: number) => ipcRenderer.invoke('analytics:getContactRankings', limit),
    getTimeDistribution: () => ipcRenderer.invoke('analytics:getTimeDistribution')
  },

  // 群聊分析
  groupAnalytics: {
    getGroupChats: () => ipcRenderer.invoke('groupAnalytics:getGroupChats'),
    getGroupMembers: (chatroomId: string) => ipcRenderer.invoke('groupAnalytics:getGroupMembers', chatroomId),
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMessageRanking', chatroomId, limit, startTime, endTime),
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupActiveHours', chatroomId, startTime, endTime),
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMediaStats', chatroomId, startTime, endTime)
  },

  // 年度报告
  annualReport: {
    getAvailableYears: () => ipcRenderer.invoke('annualReport:getAvailableYears'),
    generateReport: (year: number) => ipcRenderer.invoke('annualReport:generateReport', year)
  },

  // 导出
  export: {
    exportSessions: (sessionIds: string[], outputDir: string, options: any) => 
      ipcRenderer.invoke('export:exportSessions', sessionIds, outputDir, options),
    exportSession: (sessionId: string, outputPath: string, options: any) => 
      ipcRenderer.invoke('export:exportSession', sessionId, outputPath, options)
  }
})
