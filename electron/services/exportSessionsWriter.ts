// @ts-nocheck
import * as fs from 'fs'
import * as path from 'path'
import type { ExportWriterHost } from './exportWriterContext'
import { isStopError, isPauseError, buildGroupNicknameIdCandidates, getClampedConcurrency, getMediaCacheKey, getStableMessageKey, normalizeUnsignedIntToken, normalizeSessionIds, pathExists, escapeHtml } from './exportServiceUtils'
import {
  parallelLimit,
  type ChatLabExport,
  type ChatLabMember,
  type ChatLabMessage,
  type ExportDisplayProfile,
  type ExportOptions,
  type ExportProgress,
  type ExportTaskControl,
  type MediaExportItem,
} from './exportServiceTypes'
import { wcdbService } from './wcdbService'
import { exportRecordService } from './exportRecordService'

type ExportServiceInstance = ExportWriterHost

export const exportSessionsMixin = {
  async exportSessions(this: ExportServiceInstance, 
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{
    success: boolean
    successCount: number
    failCount: number
    paused?: boolean
    stopped?: boolean
    pendingSessionIds?: string[]
    successSessionIds?: string[]
    failedSessionIds?: string[]
    failedSessionErrors?: Record<string, string>
    sessionOutputPaths?: Record<string, string>
    error?: string
  }> {
    let successCount = 0
    let failCount = 0
    const successSessionIds: string[] = []
    const failedSessionIds: string[] = []
    const failedSessionErrors: Record<string, string> = {}
    const sessionOutputPaths: Record<string, string> = {}
    const progressEmitter = this.createProgressEmitter(onProgress)
    let attachMediaTelemetry = false
    const emitProgress = (progress: ExportProgress, options?: { force?: boolean }) => {
      const payload = attachMediaTelemetry
        ? { ...progress, ...this.getMediaTelemetrySnapshot() }
        : progress
      progressEmitter.emit(payload, options)
    }

    try {
      const conn = await this.ensureConnected()
      if (!conn.success) {
        return { success: false, successCount: 0, failCount: sessionIds.length, error: conn.error }
      }

      this.resetMediaRuntimeState()
      const normalizedOptions = this.normalizeExportOptionsForRun(options)
      const effectiveOptions: ExportOptions = this.isMediaContentBatchExport(normalizedOptions)
        ? { ...normalizedOptions, exportVoiceAsText: false }
        : normalizedOptions

      const exportMediaEnabled = effectiveOptions.exportMedia === true &&
        Boolean(effectiveOptions.exportImages || effectiveOptions.exportVoices || effectiveOptions.exportVideos || effectiveOptions.exportEmojis || effectiveOptions.exportFiles)
      attachMediaTelemetry = exportMediaEnabled
      if (exportMediaEnabled) {
        this.triggerMediaFileCacheCleanup()
      }
      const writeLayout = this.resolveExportWriteLayout(effectiveOptions)
      const exportBaseDir = writeLayout === 'A'
        ? path.join(outputDir, 'texts')
        : outputDir
      const createdTaskDirs = new Set<string>()
      const reservedOutputPaths = new Set<string>()
      const ensureTaskDir = async (dirPath: string) => {
        if (createdTaskDirs.has(dirPath)) return
        await this.ensureExportDir(dirPath, control)
        createdTaskDirs.add(dirPath)
      }
      await ensureTaskDir(exportBaseDir)
      const sessionLayout = exportMediaEnabled
        ? (effectiveOptions.sessionLayout ?? 'per-session')
        : 'shared'
      let completedCount = 0
      const activeSessionRatios = new Map<string, number>()
      const computeAggregateCurrent = () => {
        let activeRatioSum = 0
        for (const ratio of activeSessionRatios.values()) {
          activeRatioSum += Math.max(0, Math.min(1, ratio))
        }
        return Math.min(sessionIds.length, completedCount + activeRatioSum)
      }
      const isTextContentBatchExport = effectiveOptions.contentType === 'text' && !exportMediaEnabled
      const defaultConcurrency = exportMediaEnabled ? 2 : (isTextContentBatchExport ? 1 : 4)
      const rawConcurrency = typeof effectiveOptions.exportConcurrency === 'number'
        ? Math.floor(effectiveOptions.exportConcurrency)
        : defaultConcurrency
      const maxSessionConcurrency = isTextContentBatchExport ? 1 : 6
      const clampedConcurrency = Math.max(1, Math.min(rawConcurrency, maxSessionConcurrency))
      const sessionConcurrency = clampedConcurrency
      const queue = [...sessionIds]
      let pauseRequested = false
      let stopRequested = false
      const sessionMessageCountHints = new Map<string, number>()
      const sessionLatestTimestampHints = new Map<string, number>()
      const exportStatsCacheKey = this.buildExportStatsCacheKey(sessionIds, effectiveOptions, conn.cleanedWxid)
      const cachedStatsEntry = this.getExportStatsCacheEntry(exportStatsCacheKey)
      if (cachedStatsEntry?.sessions) {
        for (const sessionId of sessionIds) {
          const snapshot = cachedStatsEntry.sessions[sessionId]
          if (!snapshot) continue
          sessionMessageCountHints.set(sessionId, Math.max(0, Math.floor(snapshot.totalCount || 0)))
          if (Number.isFinite(snapshot.lastTimestamp) && Number(snapshot.lastTimestamp) > 0) {
            sessionLatestTimestampHints.set(sessionId, Math.floor(Number(snapshot.lastTimestamp)))
          }
        }
      }
      const canUseSessionSnapshotHints = isTextContentBatchExport &&
        this.isUnboundedDateRange(effectiveOptions.dateRange) &&
        !String(effectiveOptions.senderUsername || '').trim()
      const canFastSkipEmptySessions = false
      const canTrySkipUnchangedTextSessions = canUseSessionSnapshotHints
      const precheckSessionIds = canFastSkipEmptySessions
        ? sessionIds.filter((sessionId) => !sessionMessageCountHints.has(sessionId))
        : []
      if (canFastSkipEmptySessions && precheckSessionIds.length > 0) {
        const EMPTY_SESSION_PRECHECK_LIMIT = 1200
        if (precheckSessionIds.length <= EMPTY_SESSION_PRECHECK_LIMIT) {
          let checkedCount = 0
          emitProgress({
            current: computeAggregateCurrent(),
            total: sessionIds.length,
            currentSession: '',
            currentSessionId: '',
            phase: 'preparing',
            phaseProgress: 0,
            phaseTotal: precheckSessionIds.length,
            phaseLabel: `预检查空会话 0/${precheckSessionIds.length}`
          })

          const PRECHECK_BATCH_SIZE = 160
          for (let i = 0; i < precheckSessionIds.length; i += PRECHECK_BATCH_SIZE) {
            if (control?.shouldStop?.()) {
              stopRequested = true
              break
            }
            if (control?.shouldPause?.()) {
              pauseRequested = true
              break
            }

            const batchSessionIds = precheckSessionIds.slice(i, i + PRECHECK_BATCH_SIZE)
            const countsResult = await wcdbService.getMessageCounts(batchSessionIds)
            if (countsResult.success && countsResult.counts) {
              for (const batchSessionId of batchSessionIds) {
                const count = countsResult.counts[batchSessionId]
                if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
                  sessionMessageCountHints.set(batchSessionId, Math.max(0, Math.floor(count)))
                }
              }
            }

            checkedCount = Math.min(precheckSessionIds.length, checkedCount + batchSessionIds.length)
            emitProgress({
              current: computeAggregateCurrent(),
              total: sessionIds.length,
              currentSession: '',
              currentSessionId: '',
              phase: 'preparing',
              phaseProgress: checkedCount,
              phaseTotal: precheckSessionIds.length,
              phaseLabel: `预检查空会话 ${checkedCount}/${precheckSessionIds.length}`
            })
          }
        } else {
          emitProgress({
            current: computeAggregateCurrent(),
            total: sessionIds.length,
            currentSession: '',
            currentSessionId: '',
            phase: 'preparing',
            phaseLabel: `会话较多，已跳过空会话预检查（${precheckSessionIds.length} 个）`
          })
        }
      }

      if (canUseSessionSnapshotHints && sessionIds.length > 0) {
        const missingHintSessionIds = sessionIds.filter((sessionId) => (
          !sessionMessageCountHints.has(sessionId) || !sessionLatestTimestampHints.has(sessionId)
        ))
        if (missingHintSessionIds.length > 0) {
          const sessionSet = new Set(missingHintSessionIds)
          const sessionsResult = await chatService.getSessions()
          if (sessionsResult.success && Array.isArray(sessionsResult.sessions)) {
            for (const item of sessionsResult.sessions) {
              const username = String(item?.username || '').trim()
              if (!username) continue
              if (!sessionSet.has(username)) continue
              const messageCountHint = Number(item?.messageCountHint)
              if (
                !sessionMessageCountHints.has(username) &&
                Number.isFinite(messageCountHint) &&
                messageCountHint >= 0
              ) {
                sessionMessageCountHints.set(username, Math.floor(messageCountHint))
              }
              const lastTimestamp = Number(item?.lastTimestamp)
              if (
                !sessionLatestTimestampHints.has(username) &&
                Number.isFinite(lastTimestamp) &&
                lastTimestamp > 0
              ) {
                sessionLatestTimestampHints.set(username, Math.floor(lastTimestamp))
              }
            }
          }
        }
      }

      if (stopRequested) {
        return {
          success: true,
          successCount,
          failCount,
          stopped: true,
          pendingSessionIds: [...queue],
          successSessionIds,
          failedSessionIds,
          failedSessionErrors,
          sessionOutputPaths
        }
      }
      if (pauseRequested) {
        return {
          success: true,
          successCount,
          failCount,
          paused: true,
          pendingSessionIds: [...queue],
          successSessionIds,
          failedSessionIds,
          failedSessionErrors,
          sessionOutputPaths
        }
      }

      const runOne = async (sessionId: string): Promise<'done' | 'stopped' | 'paused'> => {
        try {
          this.throwIfStopRequested(control)
          const sessionInfo = await this.getContactInfo(sessionId)
          const messageCountHint = sessionMessageCountHints.get(sessionId)
          const latestTimestampHint = sessionLatestTimestampHints.get(sessionId)

          const sessionProgress = (progress: ExportProgress) => {
            const phaseTotal = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : 100
            const phaseCurrent = Number.isFinite(progress.current) ? progress.current : 0
            const ratio = progress.phase === 'complete'
              ? 1
              : Math.max(0, Math.min(1, phaseCurrent / phaseTotal))
            activeSessionRatios.set(sessionId, ratio)
            emitProgress({
              ...progress,
              current: computeAggregateCurrent(),
              total: sessionIds.length,
              currentSession: sessionInfo.displayName,
              currentSessionId: sessionId
            }, { force: progress.phase === 'complete' })
          }

          sessionProgress({
            current: 0,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'preparing',
            phaseLabel: '准备导出'
          })

          const fileNamingMode = this.normalizeFileNamingMode(effectiveOptions.fileNamingMode)
          const safeName = this.buildSessionExportBaseName(sessionId, sessionInfo.displayName, effectiveOptions)
          const sessionNameWithTypePrefix = effectiveOptions.sessionNameWithTypePrefix !== false
          const sessionTypePrefix = sessionNameWithTypePrefix ? await this.getSessionFilePrefix(sessionId) : ''
          const fileNameWithPrefix = `${sessionTypePrefix}${safeName}`
          const useSessionFolder = sessionLayout === 'per-session'
          const sessionDirName = sessionNameWithTypePrefix ? `${sessionTypePrefix}${safeName}` : safeName
          const sessionDir = useSessionFolder ? path.join(exportBaseDir, sessionDirName) : exportBaseDir

          if (useSessionFolder) {
            await ensureTaskDir(sessionDir)
          }

          let ext = '.json'
          if (effectiveOptions.format === 'chatlab-jsonl') ext = '.jsonl'
          else if (effectiveOptions.format === 'excel') ext = '.xlsx'
          else if (effectiveOptions.format === 'txt') ext = '.txt'
          else if (effectiveOptions.format === 'weclone') ext = '.csv'
          else if (effectiveOptions.format === 'html') ext = '.html'
          const preferredOutputPath = path.join(sessionDir, `${fileNameWithPrefix}${ext}`)
          const canTrySkipUnchanged = canTrySkipUnchangedTextSessions &&
            typeof messageCountHint === 'number' &&
            messageCountHint >= 0 &&
            typeof latestTimestampHint === 'number' &&
            latestTimestampHint > 0 &&
            await pathExists(preferredOutputPath)
          if (canTrySkipUnchanged) {
            const latestRecord = exportRecordService.getLatestRecord(sessionId, effectiveOptions.format)
            const hasNoDataChange = Boolean(
              latestRecord &&
              latestRecord.messageCount === messageCountHint &&
              Number(latestRecord.sourceLatestMessageTimestamp || 0) >= latestTimestampHint
            )
            if (hasNoDataChange) {
              successCount++
              successSessionIds.push(sessionId)
              sessionOutputPaths[sessionId] = preferredOutputPath
              activeSessionRatios.delete(sessionId)
              completedCount++
              emitProgress({
                current: computeAggregateCurrent(),
                total: sessionIds.length,
                currentSession: sessionInfo.displayName,
                currentSessionId: sessionId,
                phase: 'complete',
                phaseLabel: '无变化，已跳过',
                estimatedTotalMessages: Math.max(0, Math.floor(messageCountHint || 0)),
                exportedMessages: Math.max(0, Math.floor(messageCountHint || 0))
              }, { force: true })
              return 'done'
            }
          }

          const outputPath = fileNamingMode === 'date-range'
            ? await this.reserveUniqueOutputPath(preferredOutputPath, reservedOutputPaths)
            : preferredOutputPath

          let result: { success: boolean; error?: string }
          if (effectiveOptions.format === 'json' || effectiveOptions.format === 'arkme-json') {
            result = await this.exportSessionToDetailedJson(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'chatlab' || effectiveOptions.format === 'chatlab-jsonl') {
            result = await this.exportSessionToChatLab(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'excel') {
            result = await this.exportSessionToExcel(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'txt') {
            result = await this.exportSessionToTxt(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'weclone') {
            result = await this.exportSessionToWeCloneCsv(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'html') {
            result = await this.exportSessionToHtml(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else {
            result = { success: false, error: `不支持的格式: ${effectiveOptions.format}` }
          }

          if (!result.success && isStopError(result.error)) {
            activeSessionRatios.delete(sessionId)
            return 'stopped'
          }
          if (!result.success && isPauseError(result.error)) {
            activeSessionRatios.delete(sessionId)
            return 'paused'
          }

          if (result.success) {
            successCount++
            successSessionIds.push(sessionId)
            sessionOutputPaths[sessionId] = outputPath
            if (typeof messageCountHint === 'number' && messageCountHint >= 0) {
              exportRecordService.saveRecord(sessionId, effectiveOptions.format, messageCountHint, {
                sourceLatestMessageTimestamp: typeof latestTimestampHint === 'number' && latestTimestampHint > 0
                  ? latestTimestampHint
                  : undefined,
                outputPath
              })
            }
          } else {
            failCount++
            failedSessionIds.push(sessionId)
            failedSessionErrors[sessionId] = result.error || '导出失败'
            console.error(`导出 ${sessionId} 失败:`, result.error)
          }

          activeSessionRatios.delete(sessionId)
          completedCount++
          emitProgress({
            current: computeAggregateCurrent(),
            total: sessionIds.length,
            currentSession: sessionInfo.displayName,
            currentSessionId: sessionId,
            phase: 'complete',
            phaseLabel: result.success ? '完成' : '导出失败'
          }, { force: true })
          return 'done'
        } catch (error) {
          if (isStopError(error)) {
            activeSessionRatios.delete(sessionId)
            return 'stopped'
          }
          if (isPauseError(error)) {
            activeSessionRatios.delete(sessionId)
            return 'paused'
          }
          throw error
        }
      }

      if (isTextContentBatchExport) {
        // 文本内容批量导出使用串行调度，降低数据库与文件系统抢占，行为更贴近 wxdaochu。
        while (queue.length > 0) {
          if (control?.shouldStop?.()) {
            stopRequested = true
            break
          }
          if (control?.shouldPause?.()) {
            pauseRequested = true
            break
          }

          const sessionId = queue.shift()
          if (!sessionId) break
          const runState = await runOne(sessionId)
          await new Promise(resolve => setImmediate(resolve))
          if (runState === 'stopped') {
            stopRequested = true
            queue.unshift(sessionId)
            break
          }
          if (runState === 'paused') {
            pauseRequested = true
            queue.unshift(sessionId)
            break
          }
        }
      } else {
        const workers = Array.from({ length: Math.min(sessionConcurrency, queue.length) }, async () => {
          while (queue.length > 0) {
            if (control?.shouldStop?.()) {
              stopRequested = true
              break
            }
            if (control?.shouldPause?.()) {
              pauseRequested = true
              break
            }

            const sessionId = queue.shift()
            if (!sessionId) break
            const runState = await runOne(sessionId)
            if (runState === 'stopped') {
              stopRequested = true
              queue.unshift(sessionId)
              break
            }
            if (runState === 'paused') {
              pauseRequested = true
              queue.unshift(sessionId)
              break
            }
          }
        })
        await Promise.all(workers)
      }

      const pendingSessionIds = [...queue]
      if (stopRequested && pendingSessionIds.length > 0) {
        return {
          success: true,
          successCount,
          failCount,
          stopped: true,
          pendingSessionIds,
          successSessionIds,
          failedSessionIds,
          failedSessionErrors,
          sessionOutputPaths
        }
      }
      if (pauseRequested) {
        return {
          success: true,
          successCount,
          failCount,
          paused: true,
          pendingSessionIds,
          successSessionIds,
          failedSessionIds,
          failedSessionErrors,
          sessionOutputPaths
        }
      }

      emitProgress({
        current: sessionIds.length,
        total: sessionIds.length,
        currentSession: '',
        currentSessionId: '',
        phase: 'complete'
      }, { force: true })
      progressEmitter.flush()

      const allFailed = successCount === 0 && failCount > 0
      const failureSummary = allFailed
        ? Object.values(failedSessionErrors).slice(0, 3).join('；') || '所有会话导出失败'
        : undefined
      return {
        success: !allFailed,
        successCount,
        failCount,
        successSessionIds,
        failedSessionIds,
        failedSessionErrors,
        sessionOutputPaths,
        error: failureSummary
      }
    } catch (e) {
      progressEmitter.flush()
      return { success: false, successCount, failCount, error: String(e) }
    } finally {
      this.clearMediaRuntimeState()
    }
  },
  async getExportStats(this: ExportServiceInstance, 
    sessionIds: string[],
    options: ExportOptions
  ): Promise<ExportStatsResult> {
    const conn = await this.ensureConnected()
    if (!conn.success || !conn.cleanedWxid) {
      return { totalMessages: 0, voiceMessages: 0, cachedVoiceCount: 0, needTranscribeCount: 0, mediaMessages: 0, estimatedSeconds: 0, sessions: [] }
    }
    const normalizedSessionIds = normalizeSessionIds(sessionIds)
    if (normalizedSessionIds.length === 0) {
      return { totalMessages: 0, voiceMessages: 0, cachedVoiceCount: 0, needTranscribeCount: 0, mediaMessages: 0, estimatedSeconds: 0, sessions: [] }
    }
    const cacheKey = this.buildExportStatsCacheKey(normalizedSessionIds, options, conn.cleanedWxid)
    const cachedStats = this.getExportStatsCacheEntry(cacheKey)
    if (cachedStats) {
      const cachedResult = this.cloneExportStatsResult(cachedStats.result)
      const orderedSessions: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }> = []
      const sessionMap = new Map(cachedResult.sessions.map((item) => [item.sessionId, item] as const))
      for (const sessionId of normalizedSessionIds) {
        const cachedSession = sessionMap.get(sessionId)
        if (cachedSession) orderedSessions.push(cachedSession)
      }
      if (orderedSessions.length === cachedResult.sessions.length) {
        cachedResult.sessions = orderedSessions
      }
      return cachedResult
    }

    const cleanedMyWxid = conn.cleanedWxid
    const sessionsStats: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }> = []
    const sessionSnapshotMap: Record<string, ExportStatsSessionSnapshot> = {}
    let totalMessages = 0
    let voiceMessages = 0
    let cachedVoiceCount = 0
    let mediaMessages = 0

    const hasSenderFilter = Boolean(String(options.senderUsername || '').trim())
    const canUseAggregatedStats = this.isUnboundedDateRange(options.dateRange) && !hasSenderFilter

    // 快速路径：直接复用 ChatService 聚合统计，避免逐会话 collectMessages 扫全量消息。
    if (canUseAggregatedStats) {
      try {
        let aggregatedData = this.getAggregatedSessionStatsCache(cacheKey)
        if (!aggregatedData) {
          const statsResult = await chatService.getExportSessionStats(normalizedSessionIds, {
            includeRelations: false,
            allowStaleCache: true
          })
          if (statsResult.success && statsResult.data) {
            aggregatedData = statsResult.data as Record<string, ExportAggregatedSessionMetric>
            this.setAggregatedSessionStatsCache(cacheKey, aggregatedData)
          }
        }
        if (aggregatedData) {
          const cachedVoiceCountMap = chatService.getCachedVoiceTranscriptCountMap(normalizedSessionIds)
          const fastRows = await parallelLimit(
            normalizedSessionIds,
            8,
            async (sessionId): Promise<{
              sessionId: string
              displayName: string
              totalCount: number
              voiceCount: number
              cachedVoiceCount: number
              mediaCount: number
            }> => {
              let displayName = sessionId
              try {
                const sessionInfo = await this.getContactInfo(sessionId)
                displayName = sessionInfo.displayName || sessionId
              } catch {
                // 预估阶段显示名获取失败不阻塞统计
              }

              const metric = aggregatedData?.[sessionId]
              const totalCount = Number.isFinite(metric?.totalMessages)
                ? Math.max(0, Math.floor(metric?.totalMessages ?? 0))
                : 0
              const voiceCount = Number.isFinite(metric?.voiceMessages)
                ? Math.max(0, Math.floor(metric?.voiceMessages ?? 0))
                : 0
              const imageCount = Number.isFinite(metric?.imageMessages)
                ? Math.max(0, Math.floor(metric?.imageMessages ?? 0))
                : 0
              const videoCount = Number.isFinite(metric?.videoMessages)
                ? Math.max(0, Math.floor(metric?.videoMessages ?? 0))
                : 0
              const emojiCount = Number.isFinite(metric?.emojiMessages)
                ? Math.max(0, Math.floor(metric?.emojiMessages ?? 0))
                : 0
              const lastTimestamp = Number.isFinite(metric?.lastTimestamp)
                ? Math.max(0, Math.floor(metric?.lastTimestamp ?? 0))
                : undefined
              const cachedCountRaw = Number(cachedVoiceCountMap[sessionId] || 0)
              const sessionCachedVoiceCount = Math.min(
                voiceCount,
                Number.isFinite(cachedCountRaw) ? Math.max(0, Math.floor(cachedCountRaw)) : 0
              )

              sessionSnapshotMap[sessionId] = {
                totalCount,
                voiceCount,
                imageCount,
                videoCount,
                emojiCount,
                cachedVoiceCount: sessionCachedVoiceCount,
                lastTimestamp
              }

              return {
                sessionId,
                displayName,
                totalCount,
                voiceCount,
                cachedVoiceCount: sessionCachedVoiceCount,
                mediaCount: voiceCount + imageCount + videoCount + emojiCount
              }
            }
          )

          for (const row of fastRows) {
            totalMessages += row.totalCount
            voiceMessages += row.voiceCount
            cachedVoiceCount += row.cachedVoiceCount
            mediaMessages += row.mediaCount
            sessionsStats.push({
              sessionId: row.sessionId,
              displayName: row.displayName,
              totalCount: row.totalCount,
              voiceCount: row.voiceCount
            })
          }

          const needTranscribeCount = Math.max(0, voiceMessages - cachedVoiceCount)
          const estimatedSeconds = needTranscribeCount * 2
          const result: ExportStatsResult = {
            totalMessages,
            voiceMessages,
            cachedVoiceCount,
            needTranscribeCount,
            mediaMessages,
            estimatedSeconds,
            sessions: sessionsStats
          }
          this.setExportStatsCacheEntry(cacheKey, {
            createdAt: Date.now(),
            result: this.cloneExportStatsResult(result),
            sessions: { ...sessionSnapshotMap }
          })
          return result
        }
      } catch (error) {
        // 聚合统计失败时自动回退到慢路径，保证功能正确。
      }
    }

    // 回退路径：保留旧逻辑，支持有时间范围/发送者过滤等需要精确筛选的场景。
    for (const sessionId of normalizedSessionIds) {
      const sessionInfo = await this.getContactInfo(sessionId)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        'text-fast'
      )
      const msgs = collected.rows
      let voiceCount = 0
      let imageCount = 0
      let videoCount = 0
      let emojiCount = 0
      let latestTimestamp = 0
      let cached = 0
      for (const msg of msgs) {
        if (msg.createTime > latestTimestamp) {
          latestTimestamp = msg.createTime
        }
        const localType = msg.localType
        if (localType === 34) {
          voiceCount++
          if (chatService.hasTranscriptCache(sessionId, String(msg.localId), msg.createTime)) {
            cached++
          }
          continue
        }
        if (localType === 3) imageCount++
        if (localType === 43) videoCount++
        if (localType === 47) emojiCount++
      }
      const mediaCount = voiceCount + imageCount + videoCount + emojiCount

      totalMessages += msgs.length
      voiceMessages += voiceCount
      cachedVoiceCount += cached
      mediaMessages += mediaCount
      sessionSnapshotMap[sessionId] = {
        totalCount: msgs.length,
        voiceCount,
        imageCount,
        videoCount,
        emojiCount,
        cachedVoiceCount: cached,
        lastTimestamp: latestTimestamp > 0 ? latestTimestamp : undefined
      }
      sessionsStats.push({
        sessionId,
        displayName: sessionInfo.displayName,
        totalCount: msgs.length,
        voiceCount
      })
    }

    const needTranscribeCount = Math.max(0, voiceMessages - cachedVoiceCount)
    // 预估：每条语音转文字约 2 秒
    const estimatedSeconds = needTranscribeCount * 2

    const result: ExportStatsResult = {
      totalMessages,
      voiceMessages,
      cachedVoiceCount,
      needTranscribeCount,
      mediaMessages,
      estimatedSeconds,
      sessions: sessionsStats
    }
    this.setExportStatsCacheEntry(cacheKey, {
      createdAt: Date.now(),
      result: this.cloneExportStatsResult(result),
      sessions: { ...sessionSnapshotMap }
    })
    return result
  }

  /**
   * 批量导出多个会话
   */,
}
