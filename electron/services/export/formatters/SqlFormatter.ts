import * as fs from 'fs';
import { parallelLimit } from '../../export/utils/parallelLimit';
import { MediaExportItem } from '../../export/types';

const sqlString = (value: unknown): string => {
  return `'${String(value ?? '').replace(/\u0000/g, '').replace(/'/g, "''")}'`
}

const sqlNullableString = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL'
  return sqlString(value)
}

const sqlNumber = (value: unknown): string => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? String(Math.trunc(numeric)) : 'NULL'
}

const sqlBoolean = (value: unknown): string => {
  return value ? 'TRUE' : 'FALSE'
}

const resolveMediaType = (msg: any): string | null => {
  const explicit = String(msg?.mediaType || msg?.media_type || '').trim().toLowerCase()
  if (explicit) return explicit
  const localType = Number(msg?.localType ?? msg?.local_type)
  if (localType === 3) return 'image'
  if (localType === 34) return 'voice'
  if (localType === 43) return 'video'
  if (localType === 47) return 'emoji'
  if (localType === 49 && String(msg?.content || '').includes('<filename>')) return 'file'
  return null
}

export class SqlFormatter {
  constructor(private exportService: any) {}

  public async export(sessionId: any, outputPath: any, options: any, onProgress: any, control: any): Promise<{ success: boolean; error?: string }> {
    try {
      this.exportService.throwIfStopRequested(control)
      const conn = await this.exportService.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const sessionInfo = await this.exportService.getContactInfo(sessionId)

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
      if (totalMessages === 0) {
        return { success: false, error: await this.exportService.buildNoMessagesError(sessionId, collected) }
      }
      await this.exportService.createWeliveRawOutputPlaceholder(outputPath, control)

      await this.exportService.hydrateEmojiCaptionsForMessages(sessionId, collected.rows, control)
      await this.exportService.resolveQuotedMessagesForExport(collected.rows, sessionId)

      const sortedMessages = collected.rows
      const voiceMessages = options.exportVoiceAsText
        ? sortedMessages.filter((msg: any) => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.exportService.ensureVoiceModel(onProgress)
      }

      const { mediaRootDir, mediaRelativePrefix } = this.exportService.getMediaLayout(outputPath, options)
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
        phase: 'writing',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: 0
      })

      await this.exportService.recordCreatedFileBeforeWrite(outputPath, control)
      const stream = fs.createWriteStream(outputPath, { encoding: 'utf-8' })
      const writeChunk = async (chunk: string): Promise<void> => {
        await new Promise<void>((resolve, _reject) => {
          this.exportService.throwIfStopRequested(control)
          if (!stream.write(chunk)) stream.once('drain', resolve)
          else resolve()
        })
      }
      const WRITE_BATCH = 160
      let writeBuffer: string[] = []
      const flushWriteBuffer = async (): Promise<void> => {
        if (writeBuffer.length === 0) return
        await writeChunk(writeBuffer.join(''))
        writeBuffer = []
      }

      await writeChunk([
        'BEGIN;',
        'CREATE TABLE IF NOT EXISTS weflow_messages (',
        '  session_id TEXT NOT NULL,',
        '  local_id TEXT,',
        '  message_id TEXT,',
        '  create_time BIGINT NOT NULL,',
        '  sender TEXT,',
        '  is_send BOOLEAN NOT NULL,',
        '  local_type INTEGER,',
        '  media_type TEXT,',
        '  content TEXT,',
        '  media_path TEXT',
        ');',
        'CREATE INDEX IF NOT EXISTS idx_weflow_messages_session_time ON weflow_messages (session_id, create_time);',
        ''
      ].join('\n'))

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
          : null
        let contentValue = this.exportService.formatPlainExportContent(
          msg.content,
          msg.localType,
          options,
          voiceTranscriptMap.get(this.exportService.getStableMessageKey(msg)),
          cleanedMyWxid,
          msg.senderUsername,
          msg.isSend,
          msg.emojiCaption
        )

        const quotedReplyDisplay = await this.exportService.resolveQuotedReplyDisplayWithNames({
          content: msg.content,
          isGroup: String(sessionId).includes('@chatroom'),
          displayNamePreference: options.displayNamePreference,
          getContact: async (_username: string) => ({ success: false }),
          groupNicknamesMap: new Map<string, string>(),
          cleanedMyWxid,
          rawMyWxid: this.exportService.getConfiguredMyWxid(),
          myDisplayName: cleanedMyWxid
        })
        if (quotedReplyDisplay) {
          contentValue = this.exportService.buildQuotedReplyText(quotedReplyDisplay)
        } else {
          const appendedLinkContent = this.exportService.formatLinkCardExportText(msg.content, msg.localType, 'append-url')
          if (appendedLinkContent) contentValue = appendedLinkContent
        }

        writeBuffer.push(
          `INSERT INTO weflow_messages (session_id, local_id, message_id, create_time, sender, is_send, local_type, media_type, content, media_path) VALUES (` +
          [
            sqlString(sessionId),
            sqlNullableString(msg.localId ?? msg.local_id),
            sqlNullableString(msg.serverId ?? msg.server_id ?? msg.msgId ?? msg.msg_id ?? msg.localId),
            sqlNumber(msg.createTime ?? msg.create_time),
            sqlNullableString(msg.senderUsername ?? msg.sender_username),
            sqlBoolean(msg.isSend ?? msg.is_send),
            sqlNumber(msg.localType ?? msg.local_type),
            sqlNullableString(resolveMediaType(msg)),
            sqlNullableString(contentValue),
            sqlNullableString(mediaPathValue)
          ].join(', ') +
          ');\n'
        )
        if (writeBuffer.length >= WRITE_BATCH) {
          await flushWriteBuffer()
        }

        if ((i + 1) % 200 === 0) {
          onProgress?.({
            current: 60 + Math.floor((i + 1) / totalMessages * 30),
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'writing',
            estimatedTotalMessages: totalMessages,
            collectedMessages: totalMessages,
            exportedMessages: i + 1
          })
        }
      }

      await flushWriteBuffer()
      await writeChunk('COMMIT;\n')

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
