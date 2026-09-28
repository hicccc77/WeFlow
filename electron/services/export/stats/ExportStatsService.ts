import { parallelLimit } from '../utils/parallelLimit';
import { ExportOptions, ExportProgress, ExportStatsResult, ExportStatsCacheEntry, ExportStatsSessionSnapshot, ExportAggregatedSessionMetric } from '../types';
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
import { sanitizeExportFileNamePart, resolveFileAttachmentExtensionDir, normalizeFileNamingMode, formatDateTokenBySeconds, buildDateRangeFileNamePart, buildSessionExportBaseName, reserveUniqueOutputPath } from '../../export/utils/fileNaming';
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

export class ExportStatsService {
    constructor(public context: ExportContext) {
    }

    /**
     * 获取导出前的预估统计信息
     */
    async getExportStats(sessionIds: string[], options: ExportOptions): Promise<ExportStatsResult> {
        const conn = await this.context.ensureConnected();
        if (!conn.success || !conn.cleanedAccountId) {
          return { totalMessages: 0, voiceMessages: 0, cachedVoiceCount: 0, needTranscribeCount: 0, mediaMessages: 0, estimatedSeconds: 0, sessions: [] }
        }

        const normalizedSessionIds = this.context.normalizeSessionIds(sessionIds);
        if (normalizedSessionIds.length === 0) {
          return { totalMessages: 0, voiceMessages: 0, cachedVoiceCount: 0, needTranscribeCount: 0, mediaMessages: 0, estimatedSeconds: 0, sessions: [] }
        }

        const cacheKey = this.context.buildExportStatsCacheKey(normalizedSessionIds, options, conn.cleanedAccountId);
        const cachedStats = this.context.getExportStatsCacheEntry(cacheKey);
        if (cachedStats) {
          const cachedResult = this.context.cloneExportStatsResult(cachedStats.result)
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

        const cleanedMyAccountId = conn.cleanedAccountId;
        const sessionsStats: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }> = [];
        const sessionSnapshotMap: Record<string, ExportStatsSessionSnapshot> = {};
        let totalMessages = 0;
        let voiceMessages = 0;
        let cachedVoiceCount = 0;
        let mediaMessages = 0;
        const hasSenderFilter = Boolean(String(options.senderUsername || '').trim());
        const canUseAggregatedStats = this.context.isUnboundedDateRange(options.dateRange) && !hasSenderFilter;
        if (canUseAggregatedStats) {
          try {
            let aggregatedData = this.context.getAggregatedSessionStatsCache(cacheKey)
            if (!aggregatedData) {
              const statsResult = await chatService.getExportSessionStats(normalizedSessionIds, {
                includeRelations: false,
                allowStaleCache: true
              })
              if (statsResult.success && statsResult.data) {
                aggregatedData = statsResult.data as Record<string, ExportAggregatedSessionMetric>
                this.context.setAggregatedSessionStatsCache(cacheKey, aggregatedData)
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
                    const sessionInfo = await this.context.getContactInfo(sessionId)
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
              this.context.setExportStatsCacheEntry(cacheKey, {
                createdAt: Date.now(),
                result: this.context.cloneExportStatsResult(result),
                sessions: { ...sessionSnapshotMap }
              })
              return result
            }
          } catch (error) {
            // 聚合统计失败时自动回退到慢路径，保证功能正确。
          }
        }

        for (const sessionId of normalizedSessionIds) {
          const sessionInfo = await this.context.getContactInfo(sessionId)
          const collected = await this.context.collectMessages(
            sessionId,
            cleanedMyAccountId,
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

        const needTranscribeCount = Math.max(0, voiceMessages - cachedVoiceCount);
        const estimatedSeconds = needTranscribeCount * 2;
        const result: ExportStatsResult = {
                  totalMessages,
                  voiceMessages,
                  cachedVoiceCount,
                  needTranscribeCount,
                  mediaMessages,
                  estimatedSeconds,
                  sessions: sessionsStats
                };
        this.context.setExportStatsCacheEntry(cacheKey, {
          createdAt: Date.now(),
          result: this.context.cloneExportStatsResult(result),
          sessions: { ...sessionSnapshotMap }
        })
        return result
    }

    async getAggregatedSessionStats(
      sessionIds: string[],
      options: ExportOptions
    ): Promise<import('../types').ExportAggregatedSessionStatsCacheEntry | null> {
      const conn = await this.context.ensureConnected()
      if (!conn.success || !conn.cleanedAccountId) return null

      const normalizedSessionIds = this.context.normalizeSessionIds(sessionIds)
      if (normalizedSessionIds.length === 0) return null
      if (!this.context.isUnboundedDateRange(options.dateRange) || String(options.senderUsername || '').trim()) {
        return null
      }

      const cacheKey = this.context.buildExportStatsCacheKey(normalizedSessionIds, options, conn.cleanedAccountId)
      let data = this.context.getAggregatedSessionStatsCache(cacheKey)
      if (!data) {
        const statsResult = await chatService.getExportSessionStats(normalizedSessionIds, {
          includeRelations: false,
          allowStaleCache: true
        })
        if (!statsResult.success || !statsResult.data) return null
        data = statsResult.data as Record<string, ExportAggregatedSessionMetric>
        this.context.setAggregatedSessionStatsCache(cacheKey, data)
      }

      return { createdAt: Date.now(), data }
    }
}
