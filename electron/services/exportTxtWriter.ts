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
import { TXT_COLUMN_DEFINITIONS } from './exportServiceTypes'

type ExportServiceInstance = ExportWriterHost

export const exportTxtMixin = {
  async exportSessionToTxt(this: ExportServiceInstance, 
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.throwIfStopRequested(control)
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')
      const rawMyWxid = this.getConfiguredMyWxid()
      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      const contactCache = new Map<string, { success: boolean; contact?: any; error?: string }>()
      const getContactCached = async (username: string) => {
        if (contactCache.has(username)) {
          return contactCache.get(username)!
        }
        const result = await wcdbService.getContact(username)
        contactCache.set(username, result)
        return result
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collectParams = this.resolveCollectParams(options)
      const collectProgressReporter = this.createCollectProgressReporter(sessionInfo.displayName, onProgress, 5)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        collectParams.mode,
        collectParams.targetMediaTypes,
        control,
        collectProgressReporter
      )
      const totalMessages = collected.rows.length

      // 如果没有消息,不创建文件
      if (totalMessages === 0) {
        return { success: false, error: await this.buildNoMessagesError(sessionId, collected) }
      }

      await this.hydrateEmojiCaptionsForMessages(sessionId, collected.rows, control)

      // 解析引用消息
      await this.resolveQuotedMessagesForExport(collected.rows, sessionId)

      const voiceMessages = options.exportVoiceAsText
        ? collected.rows.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of collected.rows) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)

      // 获取群昵称（用于转账描述等）
      const groupNicknameCandidates = isGroup
        ? buildGroupNicknameIdCandidates([
          ...Array.from(senderUsernames.values()),
          ...collected.rows.map(msg => msg.senderUsername),
          cleanedMyWxid,
          rawMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      const sortedMessages = collected.rows

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
      const mediaMessages = this.collectMediaMessagesForExport(sortedMessages, options)

      const mediaCache = new Map<string, MediaExportItem | null>()
      const mediaDirCache = new Set<string>()
      const beforeMediaDoneFiles = this.getMediaDoneFilesCount()

      if (mediaMessages.length > 0) {
        await this.preloadMediaLookupCaches(sessionId, mediaMessages, {
          exportImages: options.exportImages,
          exportVideos: options.exportVideos
        }, control)
        const voiceMediaMessages = mediaMessages.filter(msg => msg.localType === 34)
        if (voiceMediaMessages.length > 0) {
          await this.preloadVoiceWavCache(sessionId, voiceMediaMessages, control)
        }

        onProgress?.({
          current: 25,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: this.formatMediaPhaseLabel(0, mediaMessages.length, beforeMediaDoneFiles),
          ...this.getMediaTelemetrySnapshot(),
          estimatedTotalMessages: totalMessages
        })

        const mediaConcurrency = getClampedConcurrency(options.exportConcurrency)
        let mediaExported = 0
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          this.throwIfStopRequested(control)
          const mediaKey = getMediaCacheKey(msg)
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportFiles: options.exportFiles,
              maxFileSizeMb: options.maxFileSizeMb,
              exportVoiceAsText: options.exportVoiceAsText,
              includeVideoPoster: options.format === 'html',
              dirCache: mediaDirCache,
              control
            })
            mediaCache.set(mediaKey, mediaItem)
          }
          mediaExported++
          if (mediaExported % 5 === 0 || mediaExported === mediaMessages.length) {
            onProgress?.({
              current: 25,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'exporting-media',
              phaseProgress: mediaExported,
              phaseTotal: mediaMessages.length,
              phaseLabel: this.formatMediaPhaseLabel(mediaExported, mediaMessages.length, beforeMediaDoneFiles),
              ...this.getMediaTelemetrySnapshot()
            })
          }
        })
      }
      const fileOnlyExportFailure = this.buildFileOnlyExportFailure(options, mediaMessages, beforeMediaDoneFiles)
      if (fileOnlyExportFailure) return fileOnlyExportFailure

      const voiceTranscriptMap = new Map<string, string>()

      if (voiceMessages.length > 0) {
        await this.preloadVoiceWavCache(sessionId, voiceMessages, control)

        onProgress?.({
          current: 45,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice',
          phaseProgress: 0,
          phaseTotal: voiceMessages.length,
          phaseLabel: `语音转文字 0/${voiceMessages.length}`,
          estimatedTotalMessages: totalMessages
        })

        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(getStableMessageKey(msg), transcript)
          voiceTranscribed++
          onProgress?.({
            current: 45,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: 0
      })

      await this.recordCreatedFileBeforeWrite(outputPath, control)
      const stream = fs.createWriteStream(outputPath, { encoding: 'utf-8' })
      const writeChunk = async (chunk: string): Promise<void> => {
        await new Promise<void>((resolve, _reject) => {
          this.throwIfStopRequested(control)
          if (!stream.write(chunk)) {
            stream.once('drain', resolve)
          } else {
            resolve()
          }
        })
      }
      const WRITE_BATCH = 120
      let writeBuffer: string[] = []
      const flushWriteBuffer = async (): Promise<void> => {
        if (writeBuffer.length === 0) return
        await writeChunk(writeBuffer.join(''))
        writeBuffer = []
      }
      const senderProfileCache = new Map<string, ExportDisplayProfile>()

      for (let i = 0; i < totalMessages; i++) {
        if ((i & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]
        const mediaKey = getMediaCacheKey(msg)
        const mediaItem = mediaCache.get(mediaKey)
        const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
        const contentValue = shouldUseTranscript
          ? this.formatPlainExportContent(
            msg.content,
            msg.localType,
            options,
            voiceTranscriptMap.get(getStableMessageKey(msg)),
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend,
            msg.emojiCaption
          )
          : ((msg.localType !== 47 ? mediaItem?.relativePath : undefined)
            || this.formatPlainExportContent(
              msg.content,
              msg.localType,
              options,
              voiceTranscriptMap.get(getStableMessageKey(msg)),
              cleanedMyWxid,
              msg.senderUsername,
              msg.isSend,
              msg.emojiCaption
            ))

        // 转账消息：追加 "谁转账给谁" 信息
        let enrichedContentValue = contentValue
        if (this.isTransferExportContent(contentValue) && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            cleanedMyWxid,
            groupNicknamesMap,
            async (username) => {
              const c = await getContactCached(username)
              if (c.success && c.contact) {
                return c.contact.remark || c.contact.nickName || c.contact.alias || username
              }
              return username
            }
          )
          if (transferDesc) {
            enrichedContentValue = this.appendTransferDesc(contentValue, transferDesc)
          }
        }

        const quotedReplyDisplay = await this.resolveQuotedReplyDisplayWithNames({
          content: msg.content,
          isGroup,
          displayNamePreference: options.displayNamePreference,
          getContact: getContactCached,
          groupNicknamesMap,
          cleanedMyWxid,
          rawMyWxid,
          myDisplayName: myInfo.displayName || cleanedMyWxid
        })
        if (quotedReplyDisplay) {
          enrichedContentValue = this.buildQuotedReplyText(quotedReplyDisplay)
        }

        const appendedLinkContent = quotedReplyDisplay
          ? null
          : this.formatLinkCardExportText(msg.content, msg.localType, 'append-url')
        if (appendedLinkContent) {
          enrichedContentValue = appendedLinkContent
        }

        let senderRole: string
        let senderWxid: string
        let senderNickname: string
        let senderRemark = ''

        if (isGroup) {
          const senderProfileKey = `${msg.isSend ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid)}::${msg.isSend ? '1' : '0'}`
          let senderProfile = senderProfileCache.get(senderProfileKey)
          if (!senderProfile) {
            senderProfile = await this.resolveExportDisplayProfile(
              msg.isSend ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid),
              options.displayNamePreference,
              getContactCached,
              groupNicknamesMap,
              msg.isSend ? (myInfo.displayName || cleanedMyWxid) : (msg.senderUsername || ''),
              msg.isSend ? [rawMyWxid, cleanedMyWxid] : []
            )
            senderProfileCache.set(senderProfileKey, senderProfile)
          }
          senderWxid = senderProfile.wxid
          senderNickname = senderProfile.nickname
          senderRemark = senderProfile.remark
          senderRole = senderProfile.displayName
        } else if (msg.isSend) {
          senderRole = '我'
          senderWxid = cleanedMyWxid
          senderNickname = myInfo.displayName || cleanedMyWxid
        } else {
          senderWxid = sessionId
          const contactDetail = await getContactCached(sessionId)
          if (contactDetail.success && contactDetail.contact) {
            senderNickname = contactDetail.contact.nickName || sessionId
            senderRemark = contactDetail.contact.remark || ''
            senderRole = senderRemark || senderNickname
          } else {
            senderNickname = sessionInfo.displayName || sessionId
            senderRole = senderNickname
          }
        }

        writeBuffer.push(`${this.formatTimestamp(msg.createTime)} '${senderRole}'\n${enrichedContentValue}\n\n`)
        if (writeBuffer.length >= WRITE_BATCH) {
          await flushWriteBuffer()
        }

        if ((i + 1) % 200 === 0) {
          const progress = 60 + Math.floor((i + 1) / sortedMessages.length * 30)
          onProgress?.({
            current: progress,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting',
            estimatedTotalMessages: totalMessages,
            collectedMessages: totalMessages,
            exportedMessages: i + 1
          })
        }
      }

      await flushWriteBuffer()

      onProgress?.({
        current: 92,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: totalMessages
      })

      this.throwIfStopRequested(control)
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject)
        stream.end(() => resolve())
      })

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: totalMessages,
        writtenFiles: 1
      })

      return { success: true }
    } catch (e) {
      if (isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      if (isPauseError(e)) {
        return { success: false, error: '导出任务已暂停' }
      }
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 WeClone CSV 格式
   */,
}
