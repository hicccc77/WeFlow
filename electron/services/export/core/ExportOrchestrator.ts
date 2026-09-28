import { ExportOptions, ExportProgress, ExportTaskControl } from '../types';
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import ExcelJS from 'exceljs'
import { getEmojiPath } from 'wechat-emojis'
import { ConfigService } from '../../config'
import { wcdbService } from '../../wcdbService'
import { imageDecryptService } from '../../imageDecryptService'
import { chatService } from '../../chatService'
import { videoService } from '../../videoService'
import { voiceTranscribeService } from '../../voiceTranscribeService'
import { exportRecordService } from '../../exportRecordService'
import { EXPORT_HTML_STYLES } from '../../exportHtmlStyles'
import { LRUCache } from '../../../utils/LRUCache.js'
import { normalizeTimestampSeconds, formatTimestamp, formatIsoTimestamp, parseCompactDateTimeDigitsToSeconds, parseDateTimeTextToSeconds, normalizeExportDateRange, normalizeRowTimestampSeconds, getTimestampSecondsFromRow } from '../../export/utils/timestamp';
import { escapeHtml, escapeAttribute, renderMultilineText, decodeHtmlEntities } from '../../export/utils/htmlEscape';
import { sanitizeExportFileNamePart, resolveFileAttachmentExtensionDir, normalizeExportConflictStrategy, formatDateTokenBySeconds, buildDateRangeFileNamePart, buildSessionExportBaseName, reserveUniqueOutputPath } from '../../export/utils/fileNaming';
import { extractXmlValue, extractXmlAttribute, extractAppMessageType, normalizeAppMessageContent } from '../../export/parsers/xmlExtractor';
import { decodeMessageContent, decodeMaybeCompressed, decodeBinaryContent, looksLikeHex, looksLikeBase64 } from '../../export/parsers/contentDecoder';
import { parseVoipMessage } from '../../export/parsers/voipParser';
import { resolveTransferDesc, getTransferPrefix, isTransferExportContent, appendTransferDesc, extractAmountFromText, isSameAccountId } from '../../export/parsers/transferParser';
import { looksLikeAccountId, sanitizeQuotedContent, parseQuoteMessage } from '../../export/parsers/quoteParser';
import { parseChatHistory, formatForwardChatRecordContent } from '../../export/parsers/forwardRecordParser';
import { formatEmojiSemanticText, extractLooseHexMd5, normalizeEmojiCaption } from '../../export/parsers/fileAppParser';
import { stripSenderPrefix, cleanSystemMessage, extractReadableSystemMessageText, parseDurationSeconds } from '../../export/parsers/messageParser';
import { getPreferredDisplayName, resolveExportDisplayProfile } from '../../export/contacts/contactResolver';
import { resolveGroupNicknameByCandidates, buildGroupNicknameIdCandidates, normalizeGroupNicknameIdentity, normalizeGroupNickname } from '../../export/contacts/groupNickname';
import { getAvatarFallback } from '../../export/contacts/avatarHelper';
import { pathExists, ensureExportDir, copyFileOptimized, hardlinkOrCopyFile } from '../../export/media/fileCopy';
import { getMediaFileStat } from '../../export/media/attachmentResolver';
import { ExportContext } from "../core/ExportContext";
import { ChatLabFormatter } from '../formatters/ChatLabFormatter';
import { ExcelFormatter } from '../formatters/ExcelFormatter';
import { HtmlFormatter } from '../formatters/HtmlFormatter';
import { JsonFormatter } from '../formatters/JsonFormatter';
import { MarkdownFormatter } from '../formatters/MarkdownFormatter';
import { SqlFormatter } from '../formatters/SqlFormatter';
import { TxtFormatter } from '../formatters/TxtFormatter';
import { WeCloneFormatter } from '../formatters/WeCloneFormatter';

async function sha256File(filePath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const input = fs.createReadStream(filePath)
      input.on('error', reject)
      input.on('data', (chunk) => hash.update(chunk))
      input.on('end', () => resolve(hash.digest('hex')))
    })
}

function sha256Text(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export class ExportOrchestrator {
    constructor(public context: ExportContext) {
    }

    private async exportAtomically(
        outputPath: string,
        control: ExportTaskControl | undefined,
        writer: (temporaryPath: string, temporaryControl: ExportTaskControl | undefined) => Promise<{ success: boolean; error?: string }>
    ): Promise<{ success: boolean; error?: string }> {
        const outputDir = path.dirname(outputPath)
        const extension = path.extname(outputPath)
        const baseName = path.basename(outputPath, extension)
        const temporaryPath = path.join(
          outputDir,
          `.${baseName}.weflow-partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}${extension}`
        )
        await fs.promises.mkdir(outputDir, { recursive: true })
        this.context.registerLogicalOutputPath(temporaryPath, outputPath)
        const temporaryControl = control
          ? {
              ...control,
              recordCreatedFile: (createdPath: string) => {
                if (path.resolve(createdPath) !== path.resolve(temporaryPath)) {
                  control.recordCreatedFile?.(createdPath)
                }
              }
            }
          : undefined
        try {
          const result = await writer(temporaryPath, temporaryControl)
          if (!result.success) {
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined)
            return result
          }
          this.context.throwIfStopRequested(control)
          const stat = await fs.promises.stat(temporaryPath)
          if (!stat.isFile() || stat.size <= 0) {
            throw new Error(`导出临时文件无效: ${temporaryPath}`)
          }
          await fs.promises.rename(temporaryPath, outputPath)
          control?.recordCreatedFile?.(outputPath)
          return result
        } catch (error) {
          await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined)
          return { success: false, error: String(error) }
        } finally {
          this.context.unregisterLogicalOutputPath(temporaryPath)
        }
    }

    /**
     * 导出单个会话为 ChatLab 格式（并行优化版本）
     */
    async exportSessionToChatLab(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new ChatLabFormatter(this.context);
        return this.exportAtomically(outputPath, control, (temporaryPath, temporaryControl) => formatter.export(sessionId, temporaryPath, options, onProgress, temporaryControl));
    }

    /**
     * 导出单个会话为详细 JSON 格式（原项目格式）- 并行优化版本
     */
    async exportSessionToDetailedJson(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new JsonFormatter(this.context);
        return this.exportAtomically(outputPath, control, (temporaryPath, temporaryControl) => formatter.export(sessionId, temporaryPath, options, onProgress, temporaryControl));
    }

    /**
     * 导出单个会话为 Excel 格式（参考 echotrace 格式）
     */
    async exportSessionToExcel(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new ExcelFormatter(this.context);
        return this.exportAtomically(outputPath, control, (temporaryPath, temporaryControl) => formatter.export(sessionId, temporaryPath, options, onProgress, temporaryControl));
    }

    /**
     * 导出单个会话为 TXT 格式（默认与 Excel 精简列一致）
     */
    async exportSessionToTxt(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new TxtFormatter(this.context);
        return this.exportAtomically(outputPath, control, (temporaryPath, temporaryControl) => formatter.export(sessionId, temporaryPath, options, onProgress, temporaryControl));
    }

    /**
     * 导出单个会话为 WeClone CSV 格式
     */
    async exportSessionToWeCloneCsv(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new WeCloneFormatter(this.context);
        return this.exportAtomically(outputPath, control, (temporaryPath, temporaryControl) => formatter.export(sessionId, temporaryPath, options, onProgress, temporaryControl));
    }

    /**
     * 导出单个会话为 HTML 格式
     */
    async exportSessionToHtml(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new HtmlFormatter(this.context);
        return this.exportAtomically(outputPath, control, (temporaryPath, temporaryControl) => formatter.export(sessionId, temporaryPath, options, onProgress, temporaryControl));
    }

    /**
     * 导出单个会话为 Markdown 格式
     */
    async exportSessionToMarkdown(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new MarkdownFormatter(this.context);
        return this.exportAtomically(outputPath, control, (temporaryPath, temporaryControl) => formatter.export(sessionId, temporaryPath, options, onProgress, temporaryControl));
    }

    /**
     * 导出单个会话为 PostgreSQL SQL 脚本
     */
    async exportSessionToSql(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new SqlFormatter(this.context);
        return this.exportAtomically(outputPath, control, (temporaryPath, temporaryControl) => formatter.export(sessionId, temporaryPath, options, onProgress, temporaryControl));
    }

    /**
     * 批量导出多个会话
     */
    async exportSessions(sessionIds: string[], outputDir: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{
        success: boolean
        successCount: number
        skipCount?: number
        failCount: number
        paused?: boolean
        stopped?: boolean
        pendingSessionIds?: string[]
        successSessionIds?: string[]
        skippedSessionIds?: string[]
        skippedSessionReasons?: Record<string, string>
        failedSessionIds?: string[]
        failedSessionErrors?: Record<string, string>
        sessionOutputPaths?: Record<string, string>
        error?: string
        }> {
        let successCount = 0;
        let failCount = 0;
        const successSessionIds: string[] = [];
        const skippedSessionIds: string[] = [];
        const skippedSessionReasons: Record<string, string> = {};
        const failedSessionIds: string[] = [];
        const failedSessionErrors: Record<string, string> = {};
        const sessionOutputPaths: Record<string, string> = {};
        const progressEmitter = this.context.createProgressEmitter(onProgress);
        let attachMediaTelemetry = false;
        const emitProgress = (progress: ExportProgress, options?: { force?: boolean }) => {
                  const payload = attachMediaTelemetry
                    ? { ...progress, ...this.context.getMediaTelemetrySnapshot() }
                    : progress
                  progressEmitter.emit(payload, options)
                };
        try {
          const conn = await this.context.ensureConnected()
          if (!conn.success) {
            return { success: false, successCount: 0, failCount: sessionIds.length, error: conn.error }
          }

          this.context.resetMediaRuntimeState()
          const normalizedOptions = this.context.normalizeExportOptionsForRun(options)
          const effectiveOptions: ExportOptions = this.context.isMediaContentBatchExport(normalizedOptions)
            ? { ...normalizedOptions, exportVoiceAsText: false }
            : normalizedOptions
          const incrementalAccountScope = sha256Text(`${path.resolve(this.context.getConfiguredDbPath() || '.')}\0${conn.cleanedAccountId}`)
          const incrementalOptionsFingerprint = sha256Text(JSON.stringify(effectiveOptions))
          const conflictStrategy = normalizeExportConflictStrategy(effectiveOptions.exportConflictStrategy)

          const exportMediaEnabled = this.context.isMediaExportEnabled(effectiveOptions)
          attachMediaTelemetry = exportMediaEnabled
          if (exportMediaEnabled) {
            this.context.triggerMediaFileCacheCleanup()
          }
          const writeLayout = this.context.resolveExportWriteLayout(effectiveOptions)
          const exportBaseDir = writeLayout === 'A'
            ? path.join(outputDir, 'texts')
            : outputDir
          const createdTaskDirs = new Set<string>()
          const reservedOutputPaths = new Set<string>()
          const ensureTaskDir = async (dirPath: string) => {
            if (createdTaskDirs.has(dirPath)) return
            await ensureExportDir(dirPath, control)
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
          const exportStatsCacheKey = this.context.buildExportStatsCacheKey(sessionIds, effectiveOptions, conn.cleanedAccountId)
          const cachedStatsEntry = this.context.getExportStatsCacheEntry(exportStatsCacheKey)
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
            this.context.isUnboundedDateRange(effectiveOptions.dateRange) &&
            !String(effectiveOptions.senderUsername || '').trim()
          const canFastSkipEmptySessions = false
          const canTrySkipUnchangedTextSessions = canUseSessionSnapshotHints && conflictStrategy === 'incremental'
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
              skippedSessionIds,
              skippedSessionReasons,
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
              skippedSessionIds,
              skippedSessionReasons,
              failedSessionIds,
              failedSessionErrors,
              sessionOutputPaths
            }
          }

          const runOne = async (sessionId: string): Promise<'done' | 'stopped' | 'paused'> => {
            try {
              this.context.throwIfStopRequested(control)
              const sessionInfo = await this.context.getContactInfo(sessionId)
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

              const safeName = buildSessionExportBaseName(sessionId, sessionInfo.displayName, effectiveOptions)
              const sessionNameWithTypePrefix = effectiveOptions.sessionNameWithTypePrefix !== false
              const sessionTypePrefix = sessionNameWithTypePrefix ? await this.context.getSessionFilePrefix(sessionId) : ''
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
              else if (effectiveOptions.format === 'markdown') ext = '.md'
              else if (effectiveOptions.format === 'weclone') ext = '.csv'
              else if (effectiveOptions.format === 'html') ext = '.html'
              else if (effectiveOptions.format === 'sql') ext = '.sql'
              const preferredOutputPath = path.join(sessionDir, `${fileNameWithPrefix}${ext}`)
              const canTrySkipUnchanged = canTrySkipUnchangedTextSessions &&
                typeof messageCountHint === 'number' &&
                messageCountHint >= 0 &&
                typeof latestTimestampHint === 'number' &&
                latestTimestampHint > 0 &&
                await pathExists(preferredOutputPath)
              if (canTrySkipUnchanged) {
                const latestRecord = exportRecordService.getLatestRecord(sessionId, effectiveOptions.format)
                let outputIntegrityMatches = false
                if (latestRecord?.outputPath && latestRecord.outputBytes !== undefined && latestRecord.outputHash) {
                  try {
                    const stat = await fs.promises.stat(preferredOutputPath)
                    outputIntegrityMatches = path.resolve(latestRecord.outputPath) === path.resolve(preferredOutputPath) &&
                      stat.size === latestRecord.outputBytes &&
                      await sha256File(preferredOutputPath) === latestRecord.outputHash
                  } catch {
                    outputIntegrityMatches = false
                  }
                }
                const hasNoDataChange = Boolean(
                  latestRecord &&
                  latestRecord.messageCount === messageCountHint &&
                  Number(latestRecord.sourceLatestMessageTimestamp || 0) >= latestTimestampHint &&
                  latestRecord.accountScope === incrementalAccountScope &&
                  latestRecord.optionsFingerprint === incrementalOptionsFingerprint &&
                  outputIntegrityMatches
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

              const outputPath = conflictStrategy === 'rename'
                ? await reserveUniqueOutputPath(preferredOutputPath, reservedOutputPaths)
                : preferredOutputPath

              // 一旦开始重写就让旧成功记录失效；中断/失败后下次必须重试，不能被旧记录误跳过。
              exportRecordService.invalidateRecords(sessionId, effectiveOptions.format)

              let result: { success: boolean; error?: string }
              if (effectiveOptions.format === 'json' || effectiveOptions.format === 'arkme-json') {
                result = await this.exportSessionToDetailedJson(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'chatlab' || effectiveOptions.format === 'chatlab-jsonl') {
                result = await this.exportSessionToChatLab(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'excel') {
                result = await this.exportSessionToExcel(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'txt') {
                result = await this.exportSessionToTxt(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'markdown') {
                result = await this.exportSessionToMarkdown(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'weclone') {
                result = await this.exportSessionToWeCloneCsv(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'html') {
                result = await this.exportSessionToHtml(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'sql') {
                result = await this.exportSessionToSql(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else {
                result = { success: false, error: `不支持的格式: ${effectiveOptions.format}` }
              }

              if (!result.success && this.context.isStopError(result.error)) {
                activeSessionRatios.delete(sessionId)
                return 'stopped'
              }
              if (!result.success && this.context.isPauseError(result.error)) {
                activeSessionRatios.delete(sessionId)
                return 'paused'
              }

              if (result.success) {
                successCount++
                successSessionIds.push(sessionId)
                sessionOutputPaths[sessionId] = outputPath
                if (typeof messageCountHint === 'number' && messageCountHint >= 0) {
                  const outputStat = await fs.promises.stat(outputPath)
                  const outputHash = await sha256File(outputPath)
                  exportRecordService.saveRecord(sessionId, effectiveOptions.format, messageCountHint, {
                    sourceLatestMessageTimestamp: typeof latestTimestampHint === 'number' && latestTimestampHint > 0
                      ? latestTimestampHint
                      : undefined,
                    outputPath,
                    outputBytes: outputStat.size,
                    outputHash,
                    accountScope: incrementalAccountScope,
                    optionsFingerprint: incrementalOptionsFingerprint
                  })
                }
              } else if (this.context.isNoMessagesExportError(result.error)) {
                skippedSessionIds.push(sessionId)
                skippedSessionReasons[sessionId] = result.error || '该会话在指定时间范围内没有消息'
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
                phaseLabel: result.success
                  ? '完成'
                  : this.context.isNoMessagesExportError(result.error)
                    ? '无消息，已跳过'
                    : '导出失败'
              }, { force: true })
              return 'done'
            } catch (error) {
              if (this.context.isStopError(error)) {
                activeSessionRatios.delete(sessionId)
                return 'stopped'
              }
              if (this.context.isPauseError(error)) {
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
              skippedSessionIds,
              skippedSessionReasons,
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
              skippedSessionIds,
              skippedSessionReasons,
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

          const hasFailures = failCount > 0
          const failureSummary = hasFailures
            ? Object.values(failedSessionErrors).slice(0, 3).join('；') || `${failCount} 个会话导出失败`
            : undefined
          return {
            success: !hasFailures,
            successCount,
            skipCount: skippedSessionIds.length,
            failCount,
            successSessionIds,
            skippedSessionIds,
            skippedSessionReasons,
            failedSessionIds,
            failedSessionErrors,
            sessionOutputPaths,
            error: failureSummary
          }
        } catch (e) {
          progressEmitter.flush()
          return { success: false, successCount, failCount, error: String(e) }
        } finally {
          this.context.clearMediaRuntimeState()
        }
    }
}
