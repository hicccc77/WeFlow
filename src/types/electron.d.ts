import type { ChatSession, Message, Contact, ContactInfo, ChatRecordItem } from './models'

export interface SessionChatWindowOpenOptions {
  source?: 'chat' | 'export'
  initialDisplayName?: string
  initialAvatarUrl?: string
  initialContactType?: ContactInfo['type']
}

export interface ElectronAPI {
  window: {
    minimize: () => void
    maximize: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeStateChanged: (callback: (isMaximized: boolean) => void) => () => void
    close: () => void
    onCloseConfirmRequested: (callback: (payload: { canMinimizeToTray: boolean }) => void) => () => void
    respondCloseConfirm: (action: 'tray' | 'quit' | 'cancel') => Promise<boolean>
    openAgreementWindow: () => Promise<boolean>
    completeOnboarding: () => Promise<boolean>
    openOnboardingWindow: () => Promise<boolean>
    setTitleBarOverlay: (options: { symbolColor: string }) => void
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => Promise<void>
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => Promise<void>
    openImageViewerWindow: (imagePath: string, liveVideoPath?: string) => Promise<void>
    openChatHistoryWindow: (sessionId: string, messageId: number) => Promise<boolean>
    openChatHistoryPayloadWindow: (payload: { sessionId: string; title?: string; recordList: ChatRecordItem[] }) => Promise<boolean>
    getChatHistoryPayload: (payloadId: string) => Promise<{ success: boolean; payload?: { sessionId: string; title?: string; recordList: ChatRecordItem[] }; error?: string }>
    openSessionChatWindow: (sessionId: string, options?: SessionChatWindowOpenOptions) => Promise<boolean>
  }
  config: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    clear: () => Promise<boolean>
  }
  auth: {
    hello: (message?: string) => Promise<{ success: boolean; error?: string }>
    verifyEnabled: () => Promise<boolean>
    unlock: (password: string) => Promise<{ success: boolean; error?: string }>
    enableLock: (password: string) => Promise<{ success: boolean; error?: string }>
    disableLock: (password: string) => Promise<{ success: boolean; error?: string }>
    changePassword: (oldPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>
    setHelloSecret: (password: string) => Promise<{ success: boolean }>
    clearHelloSecret: () => Promise<{ success: boolean }>
    isLockMode: () => Promise<boolean>
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
    getLaunchAtStartupStatus: () => Promise<{ enabled: boolean; supported: boolean; reason?: string }>
    setLaunchAtStartup: (enabled: boolean) => Promise<{
      success: boolean
      enabled: boolean
      supported: boolean
      reason?: string
      error?: string
    }>
    checkForUpdates: () => Promise<{ hasUpdate: boolean; version?: string; releaseNotes?: string }>
    downloadAndInstall: () => Promise<void>
    ignoreUpdate: (version: string) => Promise<{ success: boolean }>
    onDownloadProgress: (callback: (progress: number) => void) => () => void
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => () => void
  }
  notification: {
    show: (data: { title: string; content: string; avatarUrl?: string; sessionId: string }) => Promise<{ success?: boolean; error?: string } | void>
    close: () => Promise<void>
    click: (sessionId: string) => void
    ready: () => void
    resize: (width: number, height: number) => void
    onShow: (callback: (event: any, data: any) => void) => () => void
    onNavigateToSession: (callback: (sessionId: string) => void) => () => void
  }
  log: {
    getPath: () => Promise<string>
    read: () => Promise<{ success: boolean; content?: string; error?: string }>
    clear: () => Promise<{ success: boolean; error?: string }>
    debug: (data: any) => void
  }
  diagnostics: {
    getExportCardLogs: (options?: { limit?: number }) => Promise<{
      logs: Array<{
        id: string
        ts: number
        source: 'frontend' | 'main' | 'backend' | 'worker'
        level: 'debug' | 'info' | 'warn' | 'error'
        message: string
        traceId?: string
        stepId?: string
        stepName?: string
        status?: 'running' | 'done' | 'failed' | 'timeout'
        durationMs?: number
        data?: Record<string, unknown>
      }>
      activeSteps: Array<{
        traceId: string
        stepId: string
        stepName: string
        source: 'frontend' | 'main' | 'backend' | 'worker'
        elapsedMs: number
        stallMs: number
        startedAt: number
        lastUpdatedAt: number
        message?: string
      }>
      summary: {
        totalLogs: number
        activeStepCount: number
        errorCount: number
        warnCount: number
        timeoutCount: number
        lastUpdatedAt: number
      }
    }>
    clearExportCardLogs: () => Promise<{ success: boolean }>
    exportExportCardLogs: (payload: {
      filePath: string
      frontendLogs?: unknown[]
    }) => Promise<{
      success: boolean
      filePath?: string
      summaryPath?: string
      count?: number
      error?: string
    }>
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
    autoGetImageKey: (manualDir?: string, wxid?: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    scanImageKeyFromMemory: (userDir: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => () => void
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => () => void
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    getSessions: () => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
    getSessionStatuses: (usernames: string[]) => Promise<{
      success: boolean
      map?: Record<string, { isFolded?: boolean; isMuted?: boolean }>
      error?: string
    }>
    getExportTabCounts: () => Promise<{
      success: boolean
      counts?: {
        private: number
        group: number
        official: number
        former_friend: number
      }
      error?: string
    }>
    getContactTypeCounts: () => Promise<{
      success: boolean
      counts?: {
        private: number
        group: number
        official: number
        former_friend: number
      }
      error?: string
    }>
    getSessionMessageCounts: (sessionIds: string[]) => Promise<{
      success: boolean
      counts?: Record<string, number>
      error?: string
    }>
    enrichSessionsContactInfo: (
      usernames: string[],
      options?: { skipDisplayName?: boolean; onlyMissingAvatar?: boolean }
    ) => Promise<{
      success: boolean
      contacts?: Record<string, { displayName?: string; avatarUrl?: string }>
      error?: string
    }>
    getMessages: (sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      nextOffset?: number;
      error?: string
    }>
    getLatestMessages: (sessionId: string, limit?: number) => Promise<{
      success: boolean
      messages?: Message[]
      hasMore?: boolean
      nextOffset?: number
      error?: string
    }>
    getNewMessages: (sessionId: string, minTime: number, limit?: number) => Promise<{
      success: boolean
      messages?: Message[]
      error?: string
    }>
    getCachedMessages: (sessionId: string) => Promise<{
      success: boolean
      messages?: Message[]
      error?: string
    }>
    clearCurrentAccountData: (options: { clearCache?: boolean; clearExports?: boolean }) => Promise<{
      success: boolean
      removedPaths?: string[]
      warning?: string
      error?: string
    }>
    getContact: (username: string) => Promise<Contact | null>
    getContactAvatar: (username: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
    updateMessage: (sessionId: string, localId: number, createTime: number, newContent: string) => Promise<{ success: boolean; error?: string }>
    deleteMessage: (sessionId: string, localId: number, createTime: number, dbPathHint?: string) => Promise<{ success: boolean; error?: string }>
    checkAntiRevokeTriggers: (sessionIds: string[]) => Promise<{
      success: boolean
      rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>
      error?: string
    }>
    installAntiRevokeTriggers: (sessionIds: string[]) => Promise<{
      success: boolean
      rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>
      error?: string
    }>
    uninstallAntiRevokeTriggers: (sessionIds: string[]) => Promise<{
      success: boolean
      rows?: Array<{ sessionId: string; success: boolean; error?: string }>
      error?: string
    }>
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) => Promise<{ payerName: string; receiverName: string }>
    getContacts: (options?: { lite?: boolean }) => Promise<{
      success: boolean
      contacts?: ContactInfo[]
      error?: string
    }>
    getMyAvatarUrl: () => Promise<{ success: boolean; avatarUrl?: string; error?: string }>
    downloadEmoji: (cdnUrl: string, md5?: string) => Promise<{ success: boolean; localPath?: string; error?: string }>
    searchMessages: (keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number) => Promise<{ success: boolean; messages?: Message[]; error?: string }>
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
    getSessionDetailFast: (sessionId: string) => Promise<{
      success: boolean
      detail?: {
        wxid: string
        displayName: string
        remark?: string
        nickName?: string
        alias?: string
        avatarUrl?: string
        messageCount: number
      }
      error?: string
    }>
    getSessionDetailExtra: (sessionId: string) => Promise<{
      success: boolean
      detail?: {
        firstMessageTime?: number
        latestMessageTime?: number
        messageTables: { dbName: string; tableName: string; count: number }[]
      }
      error?: string
    }>
    getExportSessionStats: (
      sessionIds: string[],
      options?: {
        includeRelations?: boolean
        forceRefresh?: boolean
        allowStaleCache?: boolean
        preferAccurateSpecialTypes?: boolean
        cacheOnly?: boolean
      }
    ) => Promise<{
      success: boolean
      data?: Record<string, {
        totalMessages: number
        voiceMessages: number
        imageMessages: number
        videoMessages: number
        emojiMessages: number
        transferMessages: number
        redPacketMessages: number
        callMessages: number
        firstTimestamp?: number
        lastTimestamp?: number
        privateMutualGroups?: number
        groupMemberCount?: number
        groupMyMessages?: number
        groupActiveSpeakers?: number
        groupMutualFriends?: number
      }>
      cache?: Record<string, {
        updatedAt: number
        stale: boolean
        includeRelations: boolean
        source: 'memory' | 'disk' | 'fresh'
      }>
      needsRefresh?: string[]
      error?: string
    }>
    getGroupMyMessageCountHint: (chatroomId: string) => Promise<{
      success: boolean
      count?: number
      updatedAt?: number
      source?: 'memory' | 'disk'
      error?: string
    }>
    getImageData: (sessionId: string, msgId: string) => Promise<{ success: boolean; data?: string; error?: string }>
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => Promise<{ success: boolean; data?: string; error?: string }>
    getAllVoiceMessages: (sessionId: string) => Promise<{ success: boolean; messages?: Message[]; error?: string }>
    getAllImageMessages: (sessionId: string) => Promise<{
      success: boolean
      images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[]
      error?: string
    }>
    getMessageDates: (sessionId: string) => Promise<{ success: boolean; dates?: string[]; error?: string }>
    getMessageDateCounts: (sessionId: string) => Promise<{ success: boolean; counts?: Record<string, number>; error?: string }>
    getResourceMessages: (options?: {
      sessionId?: string
      types?: Array<'image' | 'video' | 'voice' | 'file'>
      beginTimestamp?: number
      endTimestamp?: number
      limit?: number
      offset?: number
    }) => Promise<{
      success: boolean
      items?: Array<Message & {
        sessionId: string
        sessionDisplayName?: string
        resourceType: 'image' | 'video' | 'voice' | 'file'
      }>
      total?: number
      hasMore?: boolean
      error?: string
    }>
    getMediaStream: (options?: {
      sessionId?: string
      mediaType?: 'image' | 'video' | 'all'
      beginTimestamp?: number
      endTimestamp?: number
      limit?: number
      offset?: number
    }) => Promise<{
      success: boolean
      items?: Array<{
        sessionId: string
        sessionDisplayName?: string
        mediaType: 'image' | 'video'
        localId: number
        serverId?: string
        createTime: number
        localType: number
        senderUsername?: string
        isSend?: number | null
        imageMd5?: string
        imageDatName?: string
        videoMd5?: string
        content?: string
      }>
      hasMore?: boolean
      nextOffset?: number
      error?: string
    }>
    resolveVoiceCache: (sessionId: string, msgId: string) => Promise<{ success: boolean; hasCache: boolean; data?: string }>
    getVoiceTranscript: (sessionId: string, msgId: string, createTime?: number) => Promise<{ success: boolean; transcript?: string; error?: string }>
    onVoiceTranscriptPartial: (callback: (payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => void) => () => void
    getMessage: (sessionId: string, localId: number) => Promise<{ success: boolean; message?: Message; error?: string }>
    onWcdbChange: (callback: (event: any, data: { type: string; json: string }) => void) => () => void
  }
  biz: {
    listAccounts: (account?: string) => Promise<any[]>
    listMessages: (username: string, account?: string, limit?: number, offset?: number) => Promise<any[]>
    listPayRecords: (account?: string, limit?: number, offset?: number) => Promise<any[]>
  }

  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) => Promise<{ success: boolean; localPath?: string; liveVideoPath?: string; error?: string }>
    resolveCache: (payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      disableUpdateCheck?: boolean
      allowCacheIndex?: boolean
    }) => Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; liveVideoPath?: string; error?: string }>
    resolveCacheBatch: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>,
      options?: { disableUpdateCheck?: boolean; allowCacheIndex?: boolean }
    ) => Promise<{
      success: boolean
      rows?: Array<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }>
      error?: string
    }>
    preload: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>,
      options?: { allowDecrypt?: boolean; allowCacheIndex?: boolean }
    ) => Promise<boolean>
    onUpdateAvailable: (callback: (payload: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => () => void
    onCacheResolved: (callback: (payload: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => () => void
    onDecryptProgress: (callback: (payload: {
      cacheKey: string
      imageMd5?: string
      imageDatName?: string
      stage: 'queued' | 'locating' | 'decrypting' | 'writing' | 'done' | 'failed'
      progress: number
      status: 'running' | 'done' | 'error'
      message?: string
    }) => void) => () => void
  }
  video: {
    getVideoInfo: (videoMd5: string, options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => Promise<{
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
    getContactRankings: (limit?: number, beginTimestamp?: number, endTimestamp?: number) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        wechatId?: string
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
        isOwner?: boolean
      }>
      error?: string
    }>
    getGroupMembersPanelData: (
      chatroomId: string,
      options?: { forceRefresh?: boolean; includeMessageCounts?: boolean }
    ) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        nickname?: string
        alias?: string
        remark?: string
        groupNickname?: string
        isOwner?: boolean
        isFriend: boolean
        messageCount: number
      }>
      fromCache?: boolean
      updatedAt?: number
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
    getGroupMemberAnalytics: (chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: {
        statistics: {
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
        timeDistribution: Record<number, number>
      }
      error?: string
    }>
    getGroupMemberMessages: (
      chatroomId: string,
      memberUsername: string,
      options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }
    ) => Promise<{
      success: boolean
      data?: {
        messages: Message[]
        hasMore: boolean
        nextCursor: number
      }
      error?: string
    }>
    exportGroupMembers: (chatroomId: string, outputPath: string) => Promise<{
      success: boolean
      count?: number
      error?: string
    }>
    exportGroupMemberMessages: (
      chatroomId: string,
      memberUsername: string,
      outputPath: string,
      startTime?: number,
      endTime?: number
    ) => Promise<{
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
    startAvailableYearsLoad: () => Promise<{
      success: boolean
      taskId?: string
      reused?: boolean
      snapshot?: {
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
      }
      error?: string
    }>
    cancelAvailableYearsLoad: (taskId: string) => Promise<{
      success: boolean
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
        snsStats?: {
          totalPosts: number
          typeCounts?: Record<string, number>
          topLikers: { username: string; displayName: string; avatarUrl?: string; count: number }[]
          topLiked: { username: string; displayName: string; avatarUrl?: string; count: number }[]
        }
        lostFriend: {
          username: string
          displayName: string
          avatarUrl?: string
          earlyCount: number
          lateCount: number
          periodDesc: string
        } | null
      }
      error?: string
    }>
    exportImages: (payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) => Promise<{
      success: boolean
      dir?: string
      error?: string
    }>
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
    }) => void) => () => void
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => () => void
  }
  dualReport: {
    generateReport: (payload: { friendUsername: string; year: number }) => Promise<{
      success: boolean
      data?: {
        year: number
        selfName: string
        selfAvatarUrl?: string
        friendUsername: string
        friendName: string
        friendAvatarUrl?: string
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
          myTopEmojiCount?: number
          friendTopEmojiCount?: number
          topPhrases: Array<{ phrase: string; count: number }>
          myExclusivePhrases: Array<{ phrase: string; count: number }>
          friendExclusivePhrases: Array<{ phrase: string; count: number }>
          heatmap?: number[][]
          initiative?: { initiated: number; received: number }
          response?: { avg: number; fastest: number; slowest?: number; count: number }
          monthly?: Record<string, number>
          streak?: { days: number; startDate: string; endDate: string }
        }
        topPhrases: Array<{ phrase: string; count: number }>
        myExclusivePhrases: Array<{ phrase: string; count: number }>
        friendExclusivePhrases: Array<{ phrase: string; count: number }>
        heatmap?: number[][]
        initiative?: { initiated: number; received: number }
        response?: { avg: number; fastest: number; slowest?: number; count: number }
        monthly?: Record<string, number>
        streak?: { days: number; startDate: string; endDate: string }
      }
      error?: string
    }>
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => () => void
  }
  export: {
    getExportStats: (sessionIds: string[], options: any) => Promise<{
      totalMessages: number
      voiceMessages: number
      cachedVoiceCount: number
      needTranscribeCount: number
      mediaMessages: number
      estimatedSeconds: number
      sessions: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }>
    }>
    exportSessions: (sessionIds: string[], outputDir: string, options: ExportOptions) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      pendingSessionIds?: string[]
      successSessionIds?: string[]
      failedSessionIds?: string[]
      error?: string
    }>
    exportSession: (sessionId: string, outputPath: string, options: ExportOptions) => Promise<{
      success: boolean
      error?: string
    }>
    exportContacts: (outputDir: string, options: { format: 'json' | 'csv' | 'vcf'; exportAvatars: boolean; contactTypes: { friends: boolean; groups: boolean; officials: boolean }; selectedUsernames?: string[] }) => Promise<{
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
        comments: Array<{ id: string; nickname: string; content: string; refCommentId: string; refNickname?: string; emojis?: Array<{ url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }> }>
        location?: {
          latitude?: number
          longitude?: number
          city?: string
          country?: string
          poiName?: string
          poiAddress?: string
          poiAddressName?: string
          label?: string
        }
        rawXml?: string
      }>
      error?: string
    }>
    debugResource: (url: string) => Promise<{ success: boolean; status?: number; headers?: any; error?: string }>
    proxyImage: (payload: { url: string; key?: string | number }) => Promise<{ success: boolean; dataUrl?: string; videoPath?: string; error?: string }>
    downloadImage: (payload: { url: string; key?: string | number }) => Promise<{ success: boolean; data?: any; contentType?: string; error?: string }>
    exportTimeline: (options: {
      outputDir: string
      format: 'json' | 'html' | 'arkmejson'
      usernames?: string[]
      keyword?: string
      exportImages?: boolean
      exportLivePhotos?: boolean
      exportVideos?: boolean
      startTime?: number
      endTime?: number
    }) => Promise<{ success: boolean; filePath?: string; postCount?: number; mediaCount?: number; error?: string }>
    onExportProgress: (callback: (payload: { current: number; total: number; status: string }) => void) => () => void
    selectExportDir: () => Promise<{ canceled: boolean; filePath?: string }>
    getSnsUsernames: () => Promise<{ success: boolean; usernames?: string[]; error?: string }>
    getUserPostCounts: () => Promise<{ success: boolean; counts?: Record<string, number>; error?: string }>
    getExportStatsFast: () => Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }>
    getExportStats: () => Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }>
    getUserPostStats: (username: string) => Promise<{ success: boolean; data?: { username: string; totalPosts: number }; error?: string }>
    installBlockDeleteTrigger: () => Promise<{ success: boolean; alreadyInstalled?: boolean; error?: string }>
    uninstallBlockDeleteTrigger: () => Promise<{ success: boolean; error?: string }>
    checkBlockDeleteTrigger: () => Promise<{ success: boolean; installed?: boolean; error?: string }>
    deleteSnsPost: (postId: string) => Promise<{ success: boolean; error?: string }>
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) => Promise<{ success: boolean; localPath?: string; error?: string }>
    getCacheMigrationStatus: () => Promise<{
      success: boolean
      needed: boolean
      inProgress?: boolean
      totalFiles?: number
      legacyBaseDir?: string
      currentBaseDir?: string
      items?: Array<{ label: string; sourceDir: string; targetDir: string; fileCount: number }>
      error?: string
    }>
    startCacheMigration: () => Promise<{ success: boolean; copied?: number; skipped?: number; totalFiles?: number; message?: string; error?: string }>
    onCacheMigrationProgress: (callback: (payload: {
      status: 'running' | 'done' | 'error'
      phase: 'copying' | 'cleanup' | 'done' | 'error'
      current: number
      total: number
      copied: number
      skipped: number
      remaining: number
      message?: string
      currentItemLabel?: string
    }) => void) => () => void
  }
  cloud: {
    init: () => Promise<void>
    recordPage: (pageName: string) => Promise<void>
    getLogs: () => Promise<string[]>
  }
  http: {
    start: (port?: number, host?: string) => Promise<{ success: boolean; port?: number; error?: string }>
    stop: () => Promise<{ success: boolean }>
    status: () => Promise<{ running: boolean; port: number; mediaExportPath: string }>
  }
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'txt' | 'excel' | 'weclone' | 'sql'
  contentType?: 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file'
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  fileNameSuffix?: string
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportFiles?: boolean
  maxFileSizeMb?: number
  exportVoiceAsText?: boolean
  excelCompactColumns?: boolean
  txtColumns?: string[]
  fileNamingMode?: 'classic' | 'date-range'
  sessionLayout?: 'shared' | 'per-session'
  sessionNameWithTypePrefix?: boolean
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
  imageDeepSearchOnMiss?: boolean
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  currentSessionId?: string
  phase: 'preparing' | 'exporting' | 'exporting-media' | 'exporting-voice' | 'writing' | 'complete'
  phaseProgress?: number
  phaseTotal?: number
  phaseLabel?: string
  collectedMessages?: number
  exportedMessages?: number
  estimatedTotalMessages?: number
  writtenFiles?: number
  mediaDoneFiles?: number
  mediaCacheHitFiles?: number
  mediaCacheMissFiles?: number
  mediaCacheFillFiles?: number
  mediaDedupReuseFiles?: number
  mediaBytesWritten?: number
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
