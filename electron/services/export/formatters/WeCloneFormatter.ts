import * as fs from 'fs';
//  '../../wcdbService';
import { getPreferredDisplayName, resolveExportDisplayProfile } from '../../export/contacts/contactResolver';
import { buildGroupNicknameIdCandidates, resolveGroupNicknameByCandidates } from '../../export/contacts/groupNickname';
import { formatIsoTimestamp } from '../../export/utils/timestamp';

import { parallelLimit } from '../../export/utils/parallelLimit';
import {  ExportDisplayProfile, MediaExportItem  } from '../../export/types';
import { wcdbService } from "../../wcdbService";

export class WeCloneFormatter {
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
      let totalMessages = collected.rows.length
      if (totalMessages === 0) {
        return { success: false, error: await this.exportService.buildNoMessagesError(sessionId, collected) }
      }
      await this.exportService.createWeliveRawOutputPlaceholder(outputPath, control)

      await this.exportService.hydrateEmojiCaptionsForMessages(sessionId, collected.rows, control)
      await this.exportService.resolveQuotedMessagesForExport(collected.rows, sessionId)

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
      totalMessages = sortedMessages.length
      if (totalMessages === 0) {
        return { success: false, error: '该会话在指定时间范围内没有可导出的消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? sortedMessages.filter((msg: any) => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.exportService.ensureVoiceModel(onProgress)
      }

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
      const WRITE_BATCH = 160
      let writeBuffer: string[] = []
      const flushWriteBuffer = async (): Promise<void> => {
        if (writeBuffer.length === 0) return
        await writeChunk(writeBuffer.join(''))
        writeBuffer = []
      }
      await writeChunk('\uFEFFid,MsgSvrID,type_name,is_sender,talker,msg,src,CreateTime\r\n')
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

        const typeName = this.exportService.getWeCloneTypeName(msg.localType, msg.content || '')
        let senderWxid = cleanedMyWxid
        if (!msg.isSend) {
          senderWxid = isGroup && msg.senderUsername
            ? msg.senderUsername
            : sessionId
        }

        let talker = myInfo.displayName || '我'
        if (isGroup) {
          const senderProfileKey = `${msg.isSend ? cleanedMyWxid : senderWxid}::${msg.isSend ? '1' : '0'}`
          let senderProfile = senderProfileCache.get(senderProfileKey)
          if (!senderProfile) {
            senderProfile = await resolveExportDisplayProfile(
              msg.isSend ? cleanedMyWxid : senderWxid,
              options.displayNamePreference,
              getContactCached,
              groupNicknamesMap,
              msg.isSend ? (myInfo.displayName || cleanedMyWxid) : senderWxid,
              msg.isSend ? [rawMyWxid, cleanedMyWxid] : []
            )
            senderProfileCache.set(senderProfileKey, senderProfile)
          }
          talker = senderProfile.displayName
        } else if (!msg.isSend) {
          const contactDetail = await getContactCached(senderWxid)
          const senderNickname = contactDetail.success && contactDetail.contact
            ? (contactDetail.contact.nickName || senderWxid)
            : senderWxid
          const senderRemark = contactDetail.success && contactDetail.contact
            ? (contactDetail.contact.remark || '')
            : ''
          const senderGroupNickname = isGroup
            ? resolveGroupNicknameByCandidates(groupNicknamesMap, [senderWxid])
            : ''
          talker = getPreferredDisplayName(
            senderWxid,
            senderNickname,
            senderRemark,
            senderGroupNickname,
            options.displayNamePreference || 'remark'
          )
        }

        let msgText = msg.localType === 34 && options.exportVoiceAsText
          ? (voiceTranscriptMap.get(this.exportService.getStableMessageKey(msg)) || '[语音消息 - 转文字失败]')
          : (this.exportService.parseMessageContent(
            msg.content,
            msg.localType,
            sessionId,
            msg.createTime,
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend,
            msg.emojiCaption
          ) || '')
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
          msgText = this.exportService.buildQuotedReplyText(quotedReplyDisplay)
        } else if (
          msg.localType === 244813135921 &&
          msgText === '[引用消息]' &&
          typeof msg.content === 'string' &&
          msg.content.trim()
        ) {
          msgText = msg.content.trim()
        }
        const formattedMediaItem = mediaItem?.relativePath
          ? {
            ...mediaItem,
            relativePath: this.exportService.formatExportMediaPath(mediaItem.relativePath, options, 'text')
          }
          : mediaItem
        const src = this.exportService.getWeCloneSource(msg, typeName, formattedMediaItem)
        const platformMessageId = this.exportService.getExportPlatformMessageId(msg) || ''

        const row = [
          i + 1,
          platformMessageId,
          typeName,
          msg.isSend ? 1 : 0,
          talker,
          msgText,
          src,
          formatIsoTimestamp(msg.createTime)
        ]

        writeBuffer.push(`${row.map((value) => this.exportService.escapeCsvCell(value)).join(',')}\r\n`)
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
