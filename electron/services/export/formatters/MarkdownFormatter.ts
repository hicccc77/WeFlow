import * as fs from 'fs';
import * as path from 'path';
import { resolveExportDisplayProfile } from '../../export/contacts/contactResolver';
import { buildGroupNicknameIdCandidates } from '../../export/contacts/groupNickname';
import { appendTransferDesc, isTransferExportContent, resolveTransferDesc } from '../../export/parsers/transferParser';
import { formatTimestamp } from '../../export/utils/timestamp';
import { parallelLimit } from '../../export/utils/parallelLimit';
import { buildMarkdownBlockquote, escapeMarkdownLinkText, escapeMarkdownText, toMarkdownUrl } from '../../export/utils/markdown';
import { ExportDisplayProfile, MediaExportItem } from '../../export/types';
import { wcdbService } from '../../wcdbService';

export class MarkdownFormatter {
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
        if (contactCache.has(username)) return contactCache.get(username)!
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

      if (totalMessages === 0) {
        return { success: false, error: await this.exportService.buildNoMessagesError(sessionId, collected) }
      }
      await this.exportService.createWeliveRawOutputPlaceholder(outputPath, control)

      await this.exportService.hydrateEmojiCaptionsForMessages(sessionId, collected.rows, control)
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
              includeVoiceWithTranscript: true,
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

      const exportMeta = this.exportService.getExportMeta(sessionId, sessionInfo, isGroup)
      await writeChunk(`# ${escapeMarkdownText(sessionInfo.displayName || sessionId)}\n\n`)
      await writeChunk(`- 会话ID: \`${String(sessionId).replace(/`/g, '\\`')}\`\n`)
      await writeChunk(`- 会话类型: ${isGroup ? '群聊' : '私聊'}\n`)
      await writeChunk(`- 消息数量: ${totalMessages}\n`)
      await writeChunk(`- 导出时间: ${escapeMarkdownText(formatTimestamp(exportMeta.chatlab.exportedAt))}\n`)
      await writeChunk(`- 导出工具: WeFlow\n\n---\n\n`)

      const WRITE_BATCH = 80
      let writeBuffer: string[] = []
      const flushWriteBuffer = async (): Promise<void> => {
        if (writeBuffer.length === 0) return
        await writeChunk(writeBuffer.join(''))
        writeBuffer = []
      }
      const senderProfileCache = new Map<string, ExportDisplayProfile>()

      const getSenderRole = async (msg: any): Promise<string> => {
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
          return senderProfile.displayName
        }

        if (msg.isSend) return '我'

        const contactDetail = await getContactCached(sessionId)
        if (contactDetail.success && contactDetail.contact) {
          return contactDetail.contact.remark || contactDetail.contact.nickName || sessionId
        }
        return sessionInfo.displayName || sessionId
      }

      const getRawMediaRelativePath = (msg: any): string => {
        const rawPath = String(msg?.mediaPath || msg?.media_path || '').trim()
        if (!rawPath || /^(?:https?:|data:|blob:)/i.test(rawPath)) return rawPath
        const normalized = rawPath.replace(/\\/g, '/')
        if (!path.isAbsolute(rawPath)) return normalized.replace(/^\.\//, '')

        const relativeFromMediaRoot = path.relative(mediaRootDir, rawPath)
        if (relativeFromMediaRoot && !relativeFromMediaRoot.startsWith('..') && !path.isAbsolute(relativeFromMediaRoot)) {
          return relativeFromMediaRoot.split(path.sep).join('/')
        }
        return ''
      }

      const getFallbackMediaKind = (msg: any): MediaExportItem['kind'] | null => {
        const localType = Number(msg?.localType || msg?.local_type || 0)
        const mediaType = String(msg?.mediaType || msg?.media_type || '').trim().toLowerCase()
        if (mediaType === 'image' || localType === 3) return 'image'
        if (mediaType === 'emoji' || localType === 47) return 'emoji'
        if (mediaType === 'voice' || localType === 34) return 'voice'
        if (mediaType === 'video' || localType === 43) return 'video'
        if (mediaType === 'file') return 'file'
        return null
      }

      const buildMediaMarkdown = (mediaItem: MediaExportItem | null | undefined, typeName: string, fallbackRelativePath = '', fallbackKind: MediaExportItem['kind'] | null = null): string => {
        const relativePath = mediaItem?.relativePath || fallbackRelativePath
        if (!relativePath) return ''
        const mediaUrl = toMarkdownUrl(this.exportService.formatExportMediaPath(relativePath, { exportPathStyle: 'posix' }, 'url'))
        const fileName = path.basename(relativePath.replace(/\\/g, '/')) || typeName
        const kind = mediaItem?.kind || fallbackKind

        if (kind === 'image' || kind === 'emoji') {
          return `![${escapeMarkdownLinkText(typeName)}](${mediaUrl})`
        }
        if (kind === 'voice') {
          return `[${escapeMarkdownLinkText('语音文件')}](${mediaUrl})`
        }
        if (kind === 'video') {
          return `[${escapeMarkdownLinkText('视频文件')}](${mediaUrl})`
        }
        return `[${escapeMarkdownLinkText(fileName)}](${mediaUrl})`
      }

      for (let i = 0; i < totalMessages; i++) {
        if ((i & 0x7f) === 0) this.exportService.throwIfStopRequested(control)

        const msg = sortedMessages[i]
        const mediaKey = this.exportService.getMediaCacheKey(msg)
        const mediaItem = mediaCache.has(mediaKey)
          ? mediaCache.get(mediaKey)
          : await this.exportService.resolveWeliveRawMediaItem(msg, mediaRootDir, mediaRelativePrefix, options, control)
        const senderRole = await getSenderRole(msg)
        const typeName = this.exportService.getMessageTypeName(msg.localType, msg.content)
        const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
        const mediaMarkdown = buildMediaMarkdown(mediaItem, typeName, getRawMediaRelativePath(msg), getFallbackMediaKind(msg))

        let contentValue = shouldUseTranscript
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
          : this.exportService.formatPlainExportContent(
            msg.content,
            msg.localType,
            options,
            voiceTranscriptMap.get(this.exportService.getStableMessageKey(msg)),
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend,
            msg.emojiCaption
          )

        if (mediaMarkdown && !shouldUseTranscript && (msg.localType === 3 || msg.localType === 34 || msg.localType === 43 || msg.localType === 47)) {
          contentValue = ''
        }

        if (isTransferExportContent(contentValue) && msg.content) {
          const transferDesc = await resolveTransferDesc(
            msg.content,
            cleanedMyWxid,
            groupNicknamesMap,
            async (username: string) => {
              const c = await getContactCached(username)
              if (c.success && c.contact) {
                return c.contact.remark || c.contact.nickName || c.contact.alias || username
              }
              return username
            }
          )
          if (transferDesc) {
            contentValue = appendTransferDesc(contentValue, transferDesc)
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

        const linkCard = quotedReplyDisplay ? null : this.exportService.extractHtmlLinkCard(msg.content, msg.localType)
        const parts: string[] = []
        let contentIsMarkdown = false
        if (quotedReplyDisplay) {
          const quotedLabel = quotedReplyDisplay.quotedSender
            ? `${quotedReplyDisplay.quotedSender}: ${quotedReplyDisplay.quotedPreview}`
            : quotedReplyDisplay.quotedPreview
          parts.push(buildMarkdownBlockquote(quotedLabel))
          contentValue = quotedReplyDisplay.replyText || contentValue
        } else if (linkCard?.url) {
          contentValue = `[${escapeMarkdownLinkText(linkCard.title || linkCard.url)}](${toMarkdownUrl(linkCard.url)})`
          contentIsMarkdown = true
        }
        if (mediaMarkdown) parts.push(mediaMarkdown)
        if (contentValue) parts.push(contentIsMarkdown ? contentValue : escapeMarkdownText(contentValue))

        const body = parts.length > 0 ? parts.join('\n\n') : escapeMarkdownText(`[${typeName}]`)
        writeBuffer.push(`## ${escapeMarkdownText(formatTimestamp(msg.createTime))} ${escapeMarkdownText(senderRole)}\n\n${body}\n\n`)
        if (writeBuffer.length >= WRITE_BATCH) {
          await flushWriteBuffer()
        }

        if ((i + 1) % 200 === 0) {
          onProgress?.({
            current: 60 + Math.floor((i + 1) / sortedMessages.length * 30),
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
