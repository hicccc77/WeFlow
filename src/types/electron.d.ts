import type { ChatSession, Message, Contact, ContactInfo, ChatRecordItem } from './models'

export interface SessionChatWindowOpenOptions {
  source?: 'chat' | 'export'
  initialDisplayName?: string
  initialAvatarUrl?: string
  initialContactType?: ContactInfo['type']
}

export interface SocialValidateWeiboUidResult {
  success: boolean
  uid?: string
  screenName?: string
  error?: string
}

export interface SocialSaveWeiboCookieResult {
  success: boolean
  normalized?: string
  hasCookie?: boolean
  error?: string
}

export type InsightRecordTriggerReason = 'activity' | 'silence' | 'test' | 'manual' | 'message_analysis'
export type InsightRecordSourceType = 'insight' | 'message_analysis'

export interface MessageInsightAnalysis {
  explicitText: string
  emotion: string
  intent: string
  topic: string
}

export interface MessageInsightTarget {
  targetLocalId: number
  targetCreateTime: number
  targetMessageKey: string
  targetSenderName: string
  targetTextPreview: string
  analysis: MessageInsightAnalysis
}

export interface InsightRecordLog {
  endpoint: string
  model: string
  maxTokens: number
  temperature: number
  triggerReason: InsightRecordTriggerReason
  allowContext: boolean
  contextCount: number
  systemPrompt: string
  userPrompt: string
  rawOutput: string
  finalInsight: string
  durationMs: number
  createdAt: number
  responseFormatJson?: boolean
  responseFormatFallback?: boolean
  responseFormatFallbackReason?: string
  targetMessage?: {
    localId: number
    createTime: number
    messageKey: string
    senderName: string
    textPreview: string
  }
  contextStats?: {
    requested: number
    beforeTarget: number
    afterTarget: number
    readError?: string
  }
  parsedAnalysis?: MessageInsightAnalysis
}

export interface InsightRecordSummary {
  id: string
  sourceType: InsightRecordSourceType
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerReason: InsightRecordTriggerReason
  insight: string
  read: boolean
  messageInsight?: MessageInsightTarget
}

export interface InsightRecord extends InsightRecordSummary {
  accountScope: string
  log: InsightRecordLog
}

export interface InsightRecordContactFacet {
  sessionId: string
  displayName: string
  avatarUrl?: string
  count: number
}

export interface InsightRecordFilters {
  keyword?: string
  sessionId?: string
  startTime?: number
  endTime?: number
  sourceType?: InsightRecordSourceType | 'all'
  limit?: number
  offset?: number
}

export interface InsightRecordListResult {
  success: boolean
  records: InsightRecordSummary[]
  total: number
  todayCount: number
  unreadCount: number
  contacts: InsightRecordContactFacet[]
  error?: string
}

export interface InsightRecordResult {
  success: boolean
  record?: InsightRecord
  error?: string
}

export type InsightProfileStatusValue = 'none' | 'ready' | 'running' | 'failed'

export interface InsightProfileStatus {
  sessionId: string
  status: InsightProfileStatusValue
  updatedAt?: number
  error?: string
  phase?: string
  busy?: boolean
}

export interface InsightProfileStatusListResult {
  success: boolean
  statuses: Record<string, InsightProfileStatus>
  activeTask?: {
    sessionId: string
    displayName: string
    phase: string
    startedAt: number
  }
  error?: string
}

export interface InsightProfileGenerateResult {
  success: boolean
  message: string
  cancelled?: boolean
  error?: string
}

export type GroupSummaryTriggerType = 'auto' | 'manual'

export interface GroupSummaryTopic {
  title: string
  participants: string[]
  keyPoints: string[]
  conclusion: string
}

export interface GroupSummaryLog {
  endpoint: string
  model: string
  temperature: number
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  systemPrompt: string
  userPrompt: string
  rawOutput: string
  finalSummary: string
  durationMs: number
  createdAt: number
  responseFormatJson?: boolean
  responseFormatFallback?: boolean
  responseFormatFallbackReason?: string
  parsedTopics?: GroupSummaryTopic[]
}

export interface GroupSummaryRecordSummary {
  id: string
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  topics: GroupSummaryTopic[]
  summaryText: string
}

export interface GroupSummaryRecord extends GroupSummaryRecordSummary {
  accountScope: string
  rawOutput: string
  log: GroupSummaryLog
}

export interface GroupSummaryRecordFilters {
  sessionId?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

export interface GroupSummaryRecordListResult {
  success: boolean
  records: GroupSummaryRecordSummary[]
  total: number
  error?: string
}

export interface GroupSummaryRecordResult {
  success: boolean
  record?: GroupSummaryRecord
  error?: string
}

export interface BackupProgress {
  phase: 'preparing' | 'scanning' | 'exporting' | 'packing' | 'inspecting' | 'restoring' | 'done' | 'failed'
  message: string
  current?: number
  total?: number
  detail?: string
}

export interface BackupOptions {
  includeImages?: boolean
  includeVideos?: boolean
  includeFiles?: boolean
}

export interface BackupImageDatMeta {
  version?: number
  aesSize?: number
  aes_size?: number
  xorSize?: number
  xor_size?: number
  rawSize?: number
  raw_size?: number
  flag?: number
}

export interface BackupManifest {
  version: 1
  type: 'weflow-db-snapshots'
  createdAt: string
  appVersion: string
  source: {
    wxid: string
    dbRoot: string
  }
  options?: BackupOptions
  databases: Array<{
    id: string
    kind: 'session' | 'contact' | 'emoticon' | 'message' | 'media' | 'sns' | 'hardlink'
    dbPath: string
    relativePath: string
    tables: Array<{
      name: string
      snapshotPath: string
      rows: number
      columns: number
      schemaSql?: string
    }>
  }>
  resources?: {
    images?: Array<{
      kind: 'image' | 'video' | 'file'
      id: string
      md5?: string
      sessionId?: string
      createTime?: number
      sourceFileName?: string
      archivePath: string
      targetRelativePath: string
      ext?: string
      size?: number
      datMeta?: BackupImageDatMeta
    }>
    videos?: Array<{
      kind: 'image' | 'video' | 'file'
      id: string
      md5?: string
      sourceFileName?: string
      archivePath: string
      targetRelativePath: string
      size?: number
    }>
    files?: Array<{
      kind: 'image' | 'video' | 'file'
      id: string
      sourceFileName?: string
      archivePath: string
      targetRelativePath: string
      size?: number
    }>
  }
}

export type CloseConfirmPayload = {
  canMinimizeToTray: boolean
  restoreMethod?: 'tray' | 'dock'
}

export interface ElectronAPI {
  window: {
    minimize: () => void
    maximize: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeStateChanged: (callback: (isMaximized: boolean) => void) => () => void
    close: () => void
    onCloseConfirmRequested: (callback: (payload: CloseConfirmPayload) => void) => () => void
    respondCloseConfirm: (action: 'tray' | 'quit' | 'cancel') => Promise<boolean>
    openAgreementWindow: () => Promise<boolean>
    completeOnboarding: () => Promise<boolean>
    openOnboardingWindow: (options?: { mode?: 'add-account' }) => Promise<boolean>
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
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
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
    show: (data: { title: string; content: string; avatarUrl?: string; sessionId: string; channel?: string; insightRecordId?: string; targetRoute?: string }) => Promise<{ success?: boolean; error?: string } | void>
    close: () => Promise<void>
    click: (payload: string | { sessionId?: string; channel?: string; insightRecordId?: string; targetRoute?: string }) => void
    ready: () => void
    resize: (width: number, height: number) => void
    glassRect: (payload: {
      card: { x: number; y: number; width: number; height: number }
      bands: Array<{ id: number; x: number; y: number; width: number; height: number }>
      dpr: number
      cornerRadius: number
      blurSigma: number
      displacementScale: number
      aberrationIntensity: number
      saturation: number
    }) => void
    glassHide: () => void
    onLuma: (
      callback: (
        bands: Record<string, { r: number; g: number; b: number; darkTail: number; lightTail: number }>
      ) => void
    ) => () => void
    onShow: (callback: (event: any, data: any) => void) => () => void
    onNavigateToSession: (callback: (sessionId: string) => void) => () => void
    onNavigateToRoute: (callback: (route: string) => void) => () => void
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
    recordResourceStats: (payload: unknown) => Promise<{ success: boolean; count?: number }>
    getResourceStats: (options?: { limit?: number }) => Promise<{
      entries: Array<{ ts: number; payload: Record<string, unknown> }>
      summary: {
        count: number
        firstTs: number
        lastTs: number
        samples?: number
        longFrames?: number
        maxRecentFrameMs?: number
        maxQueued?: number
        maxQueuedCache?: number
        maxQueuedDecrypt?: number
        maxQueuedHigh?: number
        maxQueuedNormal?: number
        maxQueuedLow?: number
        maxPending?: number
        maxActiveCache?: number
        maxActiveDecrypt?: number
        maxHighWaterQueued?: number
        maxHighWaterQueuedDecrypt?: number
        maxHighWaterQueuedLow?: number
        maxHighWaterActiveDecrypt?: number
        mediaStreamLoadSamples?: number
        mediaStreamAvgLoadMs?: number
        mediaStreamMaxLoadMs?: number
        mediaStreamNativeLoads?: number
        mediaStreamPageCacheHits?: number
        mediaStreamInflightMerges?: number
        mediaStreamAvoidedNativeLoads?: number
        mediaStreamAvoidedNativeRate?: number
        mediaStreamPageCacheHitRate?: number
        mediaStreamRowsLoaded?: number
        mediaStreamDuplicateRows?: number
        mediaStreamDuplicateRate?: number
        mediaStreamNoProgressStops?: number
        preloadAccepted?: number
        preloadDeduped?: number
        preloadHandled?: number
        preloadDedupRate?: number
        preloadCanceledActive?: number
        preloadDroppedQueued?: number
        preloadDeferredLowPriority?: number
        preloadLowPriorityIdleDeferrals?: number
        preloadActiveCacheSnapshots?: number
        preloadActiveCacheSnapshotSkipped?: number
        preloadActiveCacheSnapshotCanceled?: number
        preloadLowPriorityRejected?: number
        imagePreloadRejectedCapacity?: number
        imagePredecryptRequests?: number
        imagePredecryptBackpressureSkips?: number
        imagePredecryptRejectedCapacity?: number
        imagePredecryptDeferred?: number
        imagePredecryptPreviewUpgrades?: number
        imagePredecryptRejectRate?: number
        imagePredecryptBackpressureRate?: number
        predecryptHiddenSkips?: number
        rangeHiddenSkips?: number
        rangeDuplicateSkips?: number
        rangeVisibilityReschedules?: number
        transientStatePruneRuns?: number
        preloadTotalsBaselineCaptured?: boolean
        counterDeltas?: Record<string, number>
        preloadTotalDeltas?: Record<string, number>
      }
    }>
    clearResourceStats: () => Promise<{ success: boolean }>
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
  backup: {
    create: (payload: { outputPath: string; options?: BackupOptions }) => Promise<{
      success: boolean
      filePath?: string
      manifest?: BackupManifest
      error?: string
    }>
    inspect: (payload: { archivePath: string }) => Promise<{
      success: boolean
      manifest?: BackupManifest
      error?: string
    }>
    restore: (payload: { archivePath: string }) => Promise<{
      success: boolean
      inserted?: number
      ignored?: number
      skipped?: number
      error?: string
    }>
    onProgress: (callback: (progress: BackupProgress) => void) => () => void
  }
  key: {
    autoGetDbKey: () => Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }>
    autoGetImageKey: (manualDir?: string, wxid?: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }>
    scanImageKeyFromMemory: (userDir: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => () => void
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => () => void
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    getSessions: () => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
    markAllSessionsRead: () => Promise<{ success: boolean; error?: string }>
    getAntiRevokeSessions: () => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
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
        blocked?: number
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
        blocked?: number
      }
      error?: string
    }>
    getSessionMessageCounts: (sessionIds: string[], options?: { preferHintCache?: boolean; bypassSessionCache?: boolean }) => Promise<{
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
    getNewMessages: (sessionId: string, minTime: number, limit?: number, cursor?: {
      createTime?: number
      sortSeq?: number
      localId?: number
      serverId?: number | string
      serverIdRaw?: string
    }) => Promise<{
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
    getContactAvatar: (username: string, chatroomId?: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
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
        beginTimestamp?: number
        endTimestamp?: number
      }
    ) => Promise<{
      success: boolean
      data?: Record<string, {
        totalMessages: number
        voiceMessages: number
        imageMessages: number
        videoMessages: number
        emojiMessages: number
        /** 文件类消息数量 */
        fileMessages: number
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
        rangeFiltered?: boolean
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
      streamSource?: 'native' | 'pageCache' | 'inflight'
      pageCacheHit?: boolean
      inflightMerged?: boolean
      nativeLimit?: number
      nativeRows?: number
      elapsedMs?: number
      error?: string
    }>
    resolveVoiceCache: (sessionId: string, msgId: string) => Promise<{ success: boolean; hasCache: boolean; data?: string }>
    getVoiceTranscript: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => Promise<{ success: boolean; transcript?: string; error?: string }>
    onVoiceTranscriptPartial: (callback: (payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => void) => () => void
    getMessage: (sessionId: string, localId: number) => Promise<{ success: boolean; message?: Message; error?: string }>
    getMyFootprintStats: (
      beginTimestamp: number,
      endTimestamp: number,
      options?: {
        myWxid?: string
        privateSessionIds?: string[]
        groupSessionIds?: string[]
        mentionLimit?: number
        privateLimit?: number
        mentionMode?: 'text_at_me' | string
      }
    ) => Promise<{
      success: boolean
      data?: {
        summary: {
          private_inbound_people: number
          private_replied_people: number
          private_outbound_people: number
          private_reply_rate: number
          mention_count: number
          mention_group_count: number
        }
        private_sessions: Array<{
          session_id: string
          incoming_count: number
          outgoing_count: number
          replied: boolean
          first_incoming_ts: number
          first_reply_ts: number
          latest_ts: number
          anchor_local_id: number
          anchor_create_time: number
          displayName?: string
          avatarUrl?: string
        }>
        private_segments: Array<{
          session_id: string
          segment_index: number
          start_ts: number
          end_ts: number
          duration_sec: number
          incoming_count: number
          outgoing_count: number
          message_count: number
          replied: boolean
          first_incoming_ts: number
          first_reply_ts: number
          latest_ts: number
          anchor_local_id: number
          anchor_create_time: number
          displayName?: string
          avatarUrl?: string
        }>
        mentions: Array<{
          session_id: string
          local_id: number
          create_time: number
          sender_username: string
          message_content: string
          source: string
          sessionDisplayName?: string
          senderDisplayName?: string
          senderAvatarUrl?: string
        }>
        mention_groups: Array<{
          session_id: string
          count: number
          latest_ts: number
          displayName?: string
          avatarUrl?: string
        }>
        diagnostics: {
          truncated: boolean
          scanned_dbs: number
          elapsed_ms: number
        }
      }
      error?: string
    }>
    exportMyFootprint: (
      beginTimestamp: number,
      endTimestamp: number,
      format: 'csv' | 'json',
      filePath: string
    ) => Promise<{
      success: boolean
      filePath?: string
      error?: string
    }>
    onWcdbChange: (callback: (event: any, data: { type: string; json: string }) => void) => () => void
  }
  biz: {
    listAccounts: (account?: string) => Promise<any[]>
    listAccountHealth: (account?: string) => Promise<any>
    listMessages: (username: string, account?: string, limit?: number, offset?: number) => Promise<any[]>
    listPayRecords: (account?: string, limit?: number, offset?: number) => Promise<any[]>
  }

  image: {
    decrypt: (payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      createTime?: number
      force?: boolean
      preferFilePath?: boolean
      hardlinkOnly?: boolean
      disableUpdateCheck?: boolean
      allowCacheIndex?: boolean
      allowCachePromotion?: boolean
      allowFilesystemScan?: boolean
      suppressEvents?: boolean
    }) => Promise<{ success: boolean; localPath?: string; liveVideoPath?: string; error?: string; failureKind?: 'not_found' | 'decrypt_failed' }>
    resolveCache: (payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      createTime?: number
      preferFilePath?: boolean
      hardlinkOnly?: boolean
      disableUpdateCheck?: boolean
      allowCacheIndex?: boolean
      allowCachePromotion?: boolean
      allowFilesystemScan?: boolean
      suppressEvents?: boolean
    }) => Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; liveVideoPath?: string; error?: string; failureKind?: 'not_found' | 'decrypt_failed' }>
    resolveCacheBatch: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; preferFilePath?: boolean; hardlinkOnly?: boolean }>,
      options?: { disableUpdateCheck?: boolean; allowCacheIndex?: boolean; allowCachePromotion?: boolean; allowFilesystemScan?: boolean; preferFilePath?: boolean; hardlinkOnly?: boolean; suppressEvents?: boolean }
    ) => Promise<{
      success: boolean
      rows?: Array<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string; failureKind?: 'not_found' | 'decrypt_failed' }>
      error?: string
    }>
    preload: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>,
      options?: { allowDecrypt?: boolean; allowCacheIndex?: boolean; allowFilesystemScan?: boolean; emitResolved?: boolean; scope?: string; priority?: 'high' | 'normal' | 'low' }
    ) => Promise<{
      success: true
      requested: number
      accepted: number
      mergedQueued: number
      skippedActive: number
      skippedPending: number
      ignoredCanceled: number
      rejectedCapacity: number
      deferred: number
      handledIdentities: string[]
      acceptedIdentities: string[]
      mergedQueuedIdentities: string[]
      skippedActiveIdentities: string[]
      skippedPendingIdentities: string[]
      rejectedIdentities: string[]
      deferredIdentities: string[]
    }>
    cancelPreloadScope: (scope: string) => Promise<boolean>
    getPreloadStats: () => Promise<{
      queued: number
      pending: number
      activeCache: number
      activeDecrypt: number
      queuedIdentities: number
      queuedCache: number
      queuedDecrypt: number
      queuedHigh: number
      queuedNormal: number
      queuedLow: number
      activeIdentities: number
      queuedScopes: number
      activeScopes: number
      canceledScopes: number
      highWater: {
        queued: number
        pending: number
        queuedCache: number
        queuedDecrypt: number
        queuedHigh: number
        queuedNormal: number
        queuedLow: number
        activeCache: number
        activeDecrypt: number
        activeIdentities: number
      }
      totals: {
        accepted: number
        mergedQueued: number
        skippedActive: number
        ignoredCanceled: number
        droppedQueued: number
        canceledQueued: number
        canceledActive: number
        promotedActive: number
        rejectedCapacity: number
        deferredLowPriority: number
        lowPriorityIdleDeferrals: number
        skippedPending: number
        forcedThumbnailRefreshes: number
        forcedThumbnailRefreshFailures: number
        lowPriorityRejected: number
        activeCacheSnapshots: number
        activeCacheSnapshotSkipped: number
        activeCacheSnapshotCanceled: number
        started: number
        completed: number
      }
    }>
    preloadHardlinkMd5s: (md5List: string[], options?: { chunkSize?: number; yieldMs?: number; filesystemFallback?: boolean }) => Promise<boolean>
    onUpdateAvailable: (callback: (payload: { cacheKey: string; sessionId?: string; createTime?: number; imageMd5?: string; imageDatName?: string }) => void) => () => void
    onCacheResolved: (callback: (payload: { cacheKey: string; sessionId?: string; createTime?: number; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => () => void
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
    getVideoInfoBatch: (videoMd5List: string[], options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => Promise<{
      success: boolean
      rows?: Array<{
        index: number
        md5: string
        success: boolean
        exists: boolean
        videoUrl?: string
        coverUrl?: string
        thumbUrl?: string
        error?: string
      }>
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
    getSelfSentDailyDistribution: (beginTimestamp?: number, endTimestamp?: number, force?: boolean) => Promise<{
      success: boolean
      data?: {
        unit: 'day'
        dailyDistribution: Record<string, number>
        totalMessages: number
        firstMessageTime: number | null
        lastMessageTime: number | null
        beginTimestamp: number
        endTimestamp: number
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
          topInitiatedFriend?: string
          topInitiatedCount?: number
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
    captureCurrentWindow: () => Promise<{
      success: boolean
      dataUrl?: string
      size?: { width: number; height: number }
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
    exportSessions: (sessionIds: string[], outputDir: string, options: ExportOptions, controlOptions?: { taskId?: string }) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      paused?: boolean
      stopped?: boolean
      pendingSessionIds?: string[]
      successSessionIds?: string[]
      failedSessionIds?: string[]
      failedSessionErrors?: Record<string, string>
      sessionOutputPaths?: Record<string, string>
      error?: string
    }>
    pauseTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
    resumeTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
    cancelTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
    exportSession: (sessionId: string, outputPath: string, options: ExportOptions) => Promise<{
      success: boolean
      error?: string
    }>
    exportContacts: (outputDir: string, options: { format: 'json' | 'csv' | 'vcf'; exportAvatars: boolean; contactTypes: { friends: boolean; groups: boolean; officials: boolean; blocked?: boolean }; selectedUsernames?: string[] }) => Promise<{
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
    proxyImage: (payload: { url: string; key?: string | number }) => Promise<{ success: boolean; dataUrl?: string; videoPath?: string; status?: number; error?: string }>
    downloadImage: (payload: { url: string; key?: string | number }) => Promise<{ success: boolean; data?: any; contentType?: string; error?: string }>
    exportTimeline: (options: {
      outputDir: string
      format: 'json' | 'html' | 'arkmejson' | 'markdown'
      usernames?: string[]
      keyword?: string
      exportImages?: boolean
      exportLivePhotos?: boolean
      exportVideos?: boolean
      startTime?: number
      endTime?: number
      taskId?: string
    }) => Promise<{ success: boolean; filePath?: string; postCount?: number; mediaCount?: number; paused?: boolean; stopped?: boolean; error?: string }>
    onExportProgress: (callback: (payload: { current: number; total: number; status: string }) => void) => () => void
    selectExportDir: () => Promise<{ canceled: boolean; filePath?: string }>
    getSnsUsernames: () => Promise<{ success: boolean; usernames?: string[]; error?: string }>
    getUserPostCounts: (options?: { preferCache?: boolean; forceRefresh?: boolean }) => Promise<{ success: boolean; counts?: Record<string, number>; error?: string }>
    getExportStatsFast: () => Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }>
    getExportStats: (options?: { allowTimelineFallback?: boolean; preferCache?: boolean; forceRefresh?: boolean }) => Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }>
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
  social: {
    saveWeiboCookie: (rawInput: string) => Promise<SocialSaveWeiboCookieResult>
    validateWeiboUid: (uid: string) => Promise<SocialValidateWeiboUidResult>
  }
  insight: {
    testConnection: () => Promise<{ success: boolean; message: string }>
    getTodayStats: () => Promise<Array<{ sessionId: string; count: number; times: string[] }>>
    listRecords: (filters?: InsightRecordFilters) => Promise<InsightRecordListResult>
    getRecord: (id: string) => Promise<InsightRecordResult>
    markRecordRead: (id: string) => Promise<{ success: boolean; error?: string }>
    clearRecords: (filters?: InsightRecordFilters) => Promise<{ success: boolean; removed: number; error?: string }>
    triggerTest: () => Promise<{ success: boolean; message: string }>
    triggerSessionInsight: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
    }) => Promise<{ success: boolean; message: string; recordId?: string; insight?: string; skipped?: boolean; notificationEnabled?: boolean }>
    listProfileStatuses: (sessionIds: string[]) => Promise<InsightProfileStatusListResult>
    generateProfile: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
    }) => Promise<InsightProfileGenerateResult>
    cancelProfile: (sessionId?: string) => Promise<{ success: boolean; message: string }>
    generateFootprintInsight: (payload: {
      rangeLabel: string
      summary: {
        private_inbound_people?: number
        private_replied_people?: number
        private_outbound_people?: number
        private_reply_rate?: number
        mention_count?: number
        mention_group_count?: number
      }
      privateSegments?: Array<{ displayName?: string; session_id?: string; incoming_count?: number; outgoing_count?: number; message_count?: number; replied?: boolean }>
      mentionGroups?: Array<{ displayName?: string; session_id?: string; count?: number }>
    }) => Promise<{ success: boolean; message: string; insight?: string }>
    generateMessageInsight: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      targetLocalId?: number
      targetCreateTime?: number
      targetMessageKey?: string
      targetText: string
      targetSenderName?: string
      contextCount?: number
      forceRefresh?: boolean
    }) => Promise<{ success: boolean; message: string; cached?: boolean; recordId?: string; data?: MessageInsightAnalysis }>
  }
  groupSummary: {
    listRecords: (filters?: GroupSummaryRecordFilters) => Promise<GroupSummaryRecordListResult>
    getRecord: (id: string) => Promise<GroupSummaryRecordResult>
    triggerManual: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      startTime: number
      endTime: number
    }) => Promise<{ success: boolean; message: string; recordId?: string; record?: GroupSummaryRecordSummary; skipped?: boolean; skippedReason?: string }>
    triggerDay: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      date: string
    }) => Promise<{ success: boolean; message: string; generated: number; skipped: number; records: GroupSummaryRecordSummary[] }>
  }
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'markdown' | 'txt' | 'excel' | 'weclone' | 'sql'
  contentType?: 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file'
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  fileNameSuffix?: string
  exportMedia?: boolean
  exportConflictStrategy?: 'incremental' | 'overwrite' | 'rename'
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportFiles?: boolean
  maxFileSizeMb?: number
  exportVoiceAsText?: boolean
  exportPathStyle?: 'auto' | 'posix' | 'windows'
  excelCompactColumns?: boolean
  txtColumns?: string[]
  fileNamingMode?: 'classic' | 'date-range'
  sessionLayout?: 'shared' | 'per-session'
  exportWriteLayout?: 'A' | 'B' | 'C'
  sessionNameWithTypePrefix?: boolean
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
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
