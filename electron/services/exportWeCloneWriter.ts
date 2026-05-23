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

type ExportServiceInstance = ExportWriterHost

export const exportWeCloneMixin = {
  async exportSessionToWeCloneCsv(this: ExportServiceInstance, 
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
      let totalMessages = collected.rows.length
      if (totalMessages === 0) {
        return { success: false, error: await this.buildNoMessagesError(sessionId, collected) }
      }

      await this.hydrateEmojiCaptionsForMessages(sessionId, collected.rows, control)

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
        .filter((msg) => !this.isQuotedReplyMessage(msg.localType, msg.content || ''))
      totalMessages = sortedMessages.length
      if (totalMessages === 0) {
        return { success: false, error: '该会话在指定时间范围内没有可导出的消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? sortedMessages.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

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
          this.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]
        const mediaKey = getMediaCacheKey(msg)
        const mediaItem = mediaCache.get(mediaKey) || null

        const typeName = this.getWeCloneTypeName(msg.localType, msg.content || '')
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
            senderProfile = await this.resolveExportDisplayProfile(
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
            ? this.resolveGroupNicknameByCandidates(groupNicknamesMap, [senderWxid])
            : ''
          talker = this.getPreferredDisplayName(
            senderWxid,
            senderNickname,
            senderRemark,
            senderGroupNickname,
            options.displayNamePreference || 'remark'
          )
        }

        const msgText = msg.localType === 34 && options.exportVoiceAsText
          ? (voiceTranscriptMap.get(getStableMessageKey(msg)) || '[语音消息 - 转文字失败]')
          : (this.parseMessageContent(
            msg.content,
            msg.localType,
            sessionId,
            msg.createTime,
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend,
            msg.emojiCaption
          ) || '')
        const src = this.getWeCloneSource(msg, typeName, mediaItem)
        const platformMessageId = this.getExportPlatformMessageId(msg) || ''

        const row = [
          i + 1,
          platformMessageId,
          typeName,
          msg.isSend ? 1 : 0,
          talker,
          msgText,
          src,
          this.formatIsoTimestamp(msg.createTime)
        ]

        writeBuffer.push(`${row.map((value) => this.escapeCsvCell(value)).join(',')}\r\n`)
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
,
}
