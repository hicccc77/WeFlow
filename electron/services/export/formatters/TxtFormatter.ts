import * as fs from 'fs';
//  '../../wcdbService';
import { resolveExportDisplayProfile } from '../../export/contacts/contactResolver';
import { buildGroupNicknameIdCandidates } from '../../export/contacts/groupNickname';
import { appendTransferDesc, isTransferExportContent, resolveTransferDesc } from '../../export/parsers/transferParser';
import { formatTimestamp } from '../../export/utils/timestamp';

import { parallelLimit } from '../../export/utils/parallelLimit';
import {  ExportDisplayProfile, MediaExportItem  } from '../../export/types';
import { wcdbService } from "../../wcdbService";

export class TxtFormatter {
  constructor(private exportService: any) {}

  public async export(sessionId: any, outputPath: any, options: any, onProgress: any, control: any): Promise<{ success: boolean; error?: string }> {
    
    try {
      this.exportService.throwIfStopRequested(control)
      const conn = await this.exportService.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')
      const rawMyWxid = this.exportService.getConfiguredMyWxid()
      const sessionInfo = await this.exportService.getContactInfo(sessionId)
      const myInfo = await this.exportService.getContactInfo(cleanedMyWxid)

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

      const collectParams = this.exportService.resolveCollectParams(options)
      const collectProgressReporter = this.exportService.createCollectProgressReporter(sessionInfo.displayName, onProgress, 5)
      const collected = await this.exportService.collectMessages(
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
        return { success: false, error: await this.exportService.buildNoMessagesError(sessionId, collected) }
      }
      await this.exportService.createWeliveRawOutputPlaceholder(outputPath, control)

      await this.exportService.hydrateEmojiCaptionsForMessages(sessionId, collected.rows, control)

      // 解析引用消息
      await this.exportService.resolveQuotedMessagesForExport(collected.rows, sessionId)

      const voiceMessages = options.exportVoiceAsText
        ? collected.rows.filter((msg: any) => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.exportService.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of collected.rows) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.exportService.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.exportService.preloadContacts(senderUsernames, contactCache)

      // 获取群昵称（用于转账描述等）
      const groupNicknameCandidates = isGroup
        ? buildGroupNicknameIdCandidates([
          ...Array.from(senderUsernames.values()),
          ...collected.rows.map((msg: any) => msg.senderUsername),
          cleanedMyWxid,
          rawMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.exportService.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      const sortedMessages = collected.rows

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.exportService.getMediaLayout(outputPath, options)
      const mediaMessages = this.exportService.collectMediaMessagesForExport(sortedMessages, options)

      const mediaCache = new Map<string, MediaExportItem | null>()
      const mediaDirCache = new Set<string>()
      const beforeMediaDoneFiles = this.exportService.getMediaDoneFilesCount()

      if (mediaMessages.length > 0) {
        await this.exportService.preloadMediaLookupCaches(sessionId, mediaMessages, {
          exportImages: options.exportImages,
          exportVideos: options.exportVideos
        }, control)
        const voiceMediaMessages = mediaMessages.filter((msg: any) => msg.localType === 34)
        if (voiceMediaMessages.length > 0) {
          await this.exportService.preloadVoiceWavCache(sessionId, voiceMediaMessages, control)
        }

        onProgress?.({
          current: 25,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: this.exportService.formatMediaPhaseLabel(0, mediaMessages.length, beforeMediaDoneFiles),
          ...this.exportService.getMediaTelemetrySnapshot(),
          estimatedTotalMessages: totalMessages
        })

        const mediaConcurrency = this.exportService.getClampedConcurrency(options.exportConcurrency)
        let mediaExported = 0
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg: any) => {
          this.exportService.throwIfStopRequested(control)
          const mediaKey = this.exportService.getMediaCacheKey(msg)
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportService.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportFiles: options.exportFiles,
              maxFileSizeMb: options.maxFileSizeMb,
              exportVoiceAsText: options.exportVoiceAsText,
              exportConflictStrategy: options.exportConflictStrategy,
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
              phaseLabel: this.exportService.formatMediaPhaseLabel(mediaExported, mediaMessages.length, beforeMediaDoneFiles),
              ...this.exportService.getMediaTelemetrySnapshot()
            })
          }
        })
      }
      await this.exportService.preloadWeliveRawEmojiMedia(sortedMessages, mediaCache, mediaRootDir, mediaRelativePrefix, options, control, onProgress, sessionInfo.displayName, 20)
      const fileOnlyExportFailure = this.exportService.buildFileOnlyExportFailure(options, mediaMessages, beforeMediaDoneFiles)
      if (fileOnlyExportFailure) return fileOnlyExportFailure

      const voiceTranscriptMap = new Map<string, string>()

      if (voiceMessages.length > 0) {
        await this.exportService.preloadVoiceWavCache(sessionId, voiceMessages, control)

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
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg: any) => {
          this.exportService.throwIfStopRequested(control)
          const transcript = await this.exportService.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername, msg.serverIdRaw || msg.serverId)
          voiceTranscriptMap.set(this.exportService.getStableMessageKey(msg), transcript)
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

      await this.exportService.recordCreatedFileBeforeWrite(outputPath, control)
      const stream = fs.createWriteStream(outputPath, { encoding: 'utf-8' })
      const writeChunk = async (chunk: string): Promise<void> => {
        await new Promise<void>((resolve, _reject) => {
          this.exportService.throwIfStopRequested(control)
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
          this.exportService.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]
        const mediaKey = this.exportService.getMediaCacheKey(msg)
        const mediaItem = mediaCache.has(mediaKey)
          ? mediaCache.get(mediaKey)
          : await this.exportService.resolveWeliveRawMediaItem(msg, mediaRootDir, mediaRelativePrefix, options, control)
        const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
        const mediaPathValue = !shouldUseTranscript && mediaItem?.relativePath
          ? this.exportService.formatExportMediaPath(mediaItem.relativePath, options, 'text')
          : undefined
        const contentValue = shouldUseTranscript
          ? this.exportService.formatPlainExportContent(
            msg.content,
            msg.localType,
            options,
            voiceTranscriptMap.get(this.exportService.getStableMessageKey(msg)),
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend,
            msg.emojiCaption
          )
          : (mediaPathValue
            || this.exportService.formatPlainExportContent(
              msg.content,
              msg.localType,
              options,
              voiceTranscriptMap.get(this.exportService.getStableMessageKey(msg)),
              cleanedMyWxid,
              msg.senderUsername,
              msg.isSend,
              msg.emojiCaption
            ))

        // 转账消息：追加 "谁转账给谁" 信息
        let enrichedContentValue = contentValue
        if (isTransferExportContent(contentValue) && msg.content) {
          const transferDesc = await resolveTransferDesc(
            msg.content,
            cleanedMyWxid,
            groupNicknamesMap,
            async (username: string) => {
              const c = await getContactCached(username as string)
              if (c.success && c.contact) {
                return c.contact.remark || c.contact.nickName || c.contact.alias || username
              }
              return username
            }
          )
          if (transferDesc) {
            enrichedContentValue = appendTransferDesc(contentValue, transferDesc)
          }
        }

        const quotedReplyDisplay = await this.exportService.resolveQuotedReplyDisplayWithNames({
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
          enrichedContentValue = this.exportService.buildQuotedReplyText(quotedReplyDisplay)
        }

        const appendedLinkContent = quotedReplyDisplay
          ? null
          : this.exportService.formatLinkCardExportText(msg.content, msg.localType, 'append-url')
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
            senderProfile = await resolveExportDisplayProfile(
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

        writeBuffer.push(`${formatTimestamp(msg.createTime)} '${senderRole}'\n${enrichedContentValue}\n\n`)
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

      this.exportService.throwIfStopRequested(control)
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
      if (this.exportService.isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      if (this.exportService.isPauseError(e)) {
        return { success: false, error: '导出任务已暂停' }
      }
      return { success: false, error: String(e) }
    }
  
  }
}
