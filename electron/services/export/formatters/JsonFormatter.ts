import * as fs from 'fs';
//  '../../wcdbService';
import { getPreferredDisplayName } from '../../export/contacts/contactResolver';
import { buildGroupNicknameIdCandidates, resolveGroupNicknameByCandidates } from '../../export/contacts/groupNickname';
import { extractReadableSystemMessageText } from '../../export/parsers/messageParser';
import { appendTransferDesc, isTransferExportContent, resolveTransferDesc } from '../../export/parsers/transferParser';
import { formatTimestamp } from '../../export/utils/timestamp';

import { parallelLimit } from '../../export/utils/parallelLimit';
import {  MediaExportItem  } from '../../export/types';
import { wcdbService } from "../../wcdbService";

export class JsonFormatter {
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
      const senderInfoMap = await this.exportService.preloadContactInfos([
        ...Array.from(senderUsernames.values()),
        cleanedMyWxid
      ])

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.exportService.getMediaLayout(outputPath, options)

      // ========== 阶段1：并行导出媒体文件 ==========
      const mediaMessages = this.exportService.collectMediaMessagesForExport(collected.rows, options)

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
          current: 15,
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
              current: 15,
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
      await this.exportService.preloadWeliveRawEmojiMedia(collected.rows, mediaCache, mediaRootDir, mediaRelativePrefix, options, control, onProgress, sessionInfo.displayName, 20)
      const fileOnlyExportFailure = this.exportService.buildFileOnlyExportFailure(options, mediaMessages, beforeMediaDoneFiles)
      if (fileOnlyExportFailure) return fileOnlyExportFailure

      // ========== 阶段2：并行语音转文字 ==========
      const voiceTranscriptMap = new Map<string, string>()

      if (voiceMessages.length > 0) {
        await this.exportService.preloadVoiceWavCache(sessionId, voiceMessages, control)

        onProgress?.({
          current: 35,
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
            current: 35,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      // ========== 预加载群昵称（用于名称显示偏好） ==========
      const groupNicknameCandidates = isGroup
        ? buildGroupNicknameIdCandidates([
          ...Array.from(senderUsernames.values()),
          ...collected.rows.map((msg: any) => msg.senderUsername),
          cleanedMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.exportService.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      // ========== 阶段3：构建消息列表 ==========
      onProgress?.({
        current: 55,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: 0
      })

      const allMessages: any[] = []
      const senderProfileMap = new Map<string, {
        displayName: string
        nickname: string
        remark: string
        groupNickname: string
      }>()
      const transferCandidates: Array<{ xml: string; messageRef: any }> = []
      let needSort = false
      let lastCreateTime = Number.NEGATIVE_INFINITY
      let messageIndex = 0
      for (const msg of collected.rows) {
        if ((messageIndex++ & 0x7f) === 0) {
          this.exportService.throwIfStopRequested(control)
        }
        const senderInfo = senderInfoMap.get(msg.senderUsername) || { displayName: msg.senderUsername || '' }
        const sourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(msg.content || '')
        const source = sourceMatch ? sourceMatch[0] : ''

        let content: string | null
        const mediaKey = this.exportService.getMediaCacheKey(msg)
        const mediaItem = mediaCache.has(mediaKey)
          ? mediaCache.get(mediaKey)
          : await this.exportService.resolveWeliveRawMediaItem(msg, mediaRootDir, mediaRelativePrefix, options, control)

        if (msg.localType === 34 && options.exportVoiceAsText) {
          content = voiceTranscriptMap.get(this.exportService.getStableMessageKey(msg)) || '[语音消息 - 转文字失败]'
        } else if (mediaItem) {
          content = this.exportService.formatExportMediaPath(mediaItem.relativePath, options, 'text')
        } else {
          content = this.exportService.parseMessageContent(
            msg.content,
            msg.localType,
            undefined,
            undefined,
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend,
            msg.emojiCaption
          )
        }
        if (this.exportService.isReadableSystemMessage(msg.localType, msg.content)) {
          content = extractReadableSystemMessageText(msg.content) || content
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
        // 对于媒体消息，不要让引用信息覆盖媒体路径
        if (quotedReplyDisplay && !mediaItem) {
          content = this.exportService.buildQuotedReplyText(quotedReplyDisplay)
        }

        const appendedLinkContent = quotedReplyDisplay
          ? null
          : this.exportService.formatLinkCardExportText(msg.content, msg.localType, 'append-url')
        if (appendedLinkContent) {
          content = appendedLinkContent
        }

        // 获取发送者信息用于名称显示
        const senderWxid = msg.senderUsername
        const contact = senderWxid
          ? (contactCache.get(senderWxid) ?? { success: false as const })
          : { success: false as const }
        const senderNickname = contact.success && contact.contact?.nickName
          ? contact.contact.nickName
          : (senderInfo.displayName || senderWxid)
        const senderRemark = contact.success && contact.contact?.remark ? contact.contact.remark : ''
        const senderGroupNickname = resolveGroupNicknameByCandidates(groupNicknamesMap, [senderWxid])

        // 使用用户偏好的显示名称
        const senderDisplayName = getPreferredDisplayName(
          senderWxid,
          senderNickname,
          senderRemark,
          senderGroupNickname,
          options.displayNamePreference || 'remark'
        )
        const existingSenderProfile = senderProfileMap.get(senderWxid)
        if (!existingSenderProfile) {
          senderProfileMap.set(senderWxid, {
            displayName: senderDisplayName,
            nickname: senderNickname,
            remark: senderRemark,
            groupNickname: senderGroupNickname
          })
        }

        const msgObj: any = {
          localId: allMessages.length + 1,
          createTime: msg.createTime,
          formattedTime: formatTimestamp(msg.createTime),
          type: this.exportService.getMessageTypeName(msg.localType, msg.content),
          localType: msg.localType,
          content,
          isSend: msg.isSend ? 1 : 0,
          senderUsername: msg.senderUsername,
          senderDisplayName,
          source,
          senderAvatarKey: msg.senderUsername
        }

        if (msg.localType === 47) {
          if (msg.emojiMd5) msgObj.emojiMd5 = msg.emojiMd5
          if (msg.emojiCdnUrl) msgObj.emojiCdnUrl = msg.emojiCdnUrl
          if (msg.emojiCaption) msgObj.emojiCaption = msg.emojiCaption
        }

        const platformMessageId = this.exportService.getExportPlatformMessageId(msg)
        if (platformMessageId) msgObj.platformMessageId = platformMessageId

        const replyToMessageId = this.exportService.getExportReplyToMessageId(msg.content)
        if (replyToMessageId) msgObj.replyToMessageId = replyToMessageId

        const appMsgMeta = this.exportService.extractArkmeAppMessageMeta(msg.content, msg.localType)
        if (appMsgMeta) {
          if (
            options.format === 'arkme-json' ||
            (options.format === 'json' && (appMsgMeta.appMsgKind === 'quote' || appMsgMeta.appMsgKind === 'link'))
          ) {
            Object.assign(msgObj, appMsgMeta)
          }
        }
        if (quotedReplyDisplay) {
          if (quotedReplyDisplay.quotedSender) msgObj.quotedSender = quotedReplyDisplay.quotedSender
          if (quotedReplyDisplay.quotedPreview) msgObj.quotedContent = quotedReplyDisplay.quotedPreview
        }

        if (options.format === 'arkme-json') {
          const contactCardMeta = this.exportService.extractArkmeContactCardMeta(msg.content, msg.localType)
          if (contactCardMeta) {
            Object.assign(msgObj, contactCardMeta)
          }
        }

        if (content && isTransferExportContent(content) && msg.content) {
          transferCandidates.push({ xml: msg.content, messageRef: msgObj })
        }

        // 位置消息：附加结构化位置字段
        if (msg.localType === 48) {
          if (msg.locationLat != null) msgObj.locationLat = msg.locationLat
          if (msg.locationLng != null) msgObj.locationLng = msg.locationLng
          if (msg.locationPoiname) msgObj.locationPoiname = msg.locationPoiname
          if (msg.locationLabel) msgObj.locationLabel = msg.locationLabel
        }

        allMessages.push(msgObj)
        if (msg.createTime < lastCreateTime) needSort = true
        lastCreateTime = msg.createTime
        if ((allMessages.length % 200) === 0 || allMessages.length === totalMessages) {
          const exportProgress = 55 + Math.floor((allMessages.length / totalMessages) * 15)
          onProgress?.({
            current: exportProgress,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting',
            estimatedTotalMessages: totalMessages,
            collectedMessages: totalMessages,
            exportedMessages: allMessages.length
          })
        }
      }

      if (transferCandidates.length > 0) {
        const transferNameCache = new Map<string, string>()
        const transferNamePromiseCache = new Map<string, Promise<string>>()
        const resolveDisplayNameByUsername = async (username: string): Promise<string> => {
          if (!username) return username
          const cachedName = transferNameCache.get(username)
          if (cachedName) return cachedName
          const pending = transferNamePromiseCache.get(username)
          if (pending) return pending
          const task = (async () => {
            const contactResult = contactCache.get(username) ?? await getContactCached(username as string)
            if (contactResult.success && contactResult.contact) {
              return contactResult.contact.remark || contactResult.contact.nickName || contactResult.contact.alias || username
            }
            return username
          })()
          transferNamePromiseCache.set(username, task)
          const resolved = await task
          transferNamePromiseCache.delete(username as string)
          transferNameCache.set(username, resolved)
          return resolved
        }

        const transferConcurrency = this.exportService.getClampedConcurrency(options.exportConcurrency, 4, 8)
        await parallelLimit(transferCandidates, transferConcurrency, async (item: any) => {
          this.exportService.throwIfStopRequested(control)
          const transferDesc = await resolveTransferDesc(
            item.xml,
            cleanedMyWxid,
            groupNicknamesMap,
            resolveDisplayNameByUsername
          )
          if (transferDesc && typeof item.messageRef.content === 'string') {
            item.messageRef.content = appendTransferDesc(item.messageRef.content, transferDesc)
          }
        })
      }

      if (needSort) {
        allMessages.sort((a, b) => a.createTime - b.createTime)
      }

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: totalMessages
      })

      // 获取会话的昵称和备注信息
      const sessionContact = contactCache.get(sessionId) ?? await getContactCached(sessionId)
      const sessionNickname = sessionContact.success && sessionContact.contact?.nickName
        ? sessionContact.contact.nickName
        : sessionInfo.displayName
      const sessionRemark = sessionContact.success && sessionContact.contact?.remark
        ? sessionContact.contact.remark
        : ''
      const sessionGroupNickname = isGroup
        ? resolveGroupNicknameByCandidates(groupNicknamesMap, [sessionId])
        : ''

      // 使用用户偏好的显示名称
      const sessionDisplayName = getPreferredDisplayName(
        sessionId,
        sessionNickname,
        sessionRemark,
        sessionGroupNickname,
        options.displayNamePreference || 'remark'
      )

      const weflow = this.exportService.getWeflowHeader()
      if (options.format === 'arkme-json' && isGroup) {
        this.exportService.throwIfStopRequested(control)
        await this.exportService.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }

      const avatarMap = options.exportAvatars
        ? await this.exportService.exportAvatars(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]: [string, any]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl },
            { username: cleanedMyWxid, avatarUrl: myInfo.avatarUrl }
          ]
        )
        : new Map<string, string>()

      const sessionPayload: any = {
        wxid: sessionId,
        nickname: sessionNickname,
        remark: sessionRemark,
        displayName: sessionDisplayName,
        type: isGroup ? '群聊' : '私聊',
        lastTimestamp: collected.lastTime,
        messageCount: allMessages.length,
        avatar: avatarMap.get(sessionId)
      }

      if (options.format === 'arkme-json') {
        const senderIdMap = new Map<string, number>()
        const senders: Array<{
          senderID: number
          wxid: string
          displayName: string
          nickname: string
          remark?: string
          groupNickname?: string
          avatar?: string
        }> = []
        const ensureSenderId = (senderWxidRaw: string): number => {
          const senderWxid = String(senderWxidRaw || '').trim() || 'unknown'
          const existed = senderIdMap.get(senderWxid)
          if (existed) return existed

          const senderID = senders.length + 1
          senderIdMap.set(senderWxid, senderID)

          const profile = senderProfileMap.get(senderWxid)
          const senderItem: {
            senderID: number
            wxid: string
            displayName: string
            nickname: string
            remark?: string
            groupNickname?: string
            avatar?: string
          } = {
            senderID,
            wxid: senderWxid,
            displayName: profile?.displayName || senderWxid,
            nickname: profile?.nickname || profile?.displayName || senderWxid
          }
          if (profile?.remark) senderItem.remark = profile.remark
          if (profile?.groupNickname) senderItem.groupNickname = profile.groupNickname
          const avatar = avatarMap.get(senderWxid)
          if (avatar) senderItem.avatar = avatar

          senders.push(senderItem)
          return senderID
        }

        const compactMessages = allMessages.map((message) => {
          this.exportService.throwIfStopRequested(control)
          const senderID = ensureSenderId(String(message.senderUsername || ''))
          const compactMessage: any = {
            localId: message.localId,
            createTime: message.createTime,
            formattedTime: message.formattedTime,
            type: message.type,
            localType: message.localType,
            content: message.content,
            isSend: message.isSend,
            senderID,
            source: message.source
          }
          if (message.platformMessageId) compactMessage.platformMessageId = message.platformMessageId
          if (message.replyToMessageId) compactMessage.replyToMessageId = message.replyToMessageId
          if (message.locationLat != null) compactMessage.locationLat = message.locationLat
          if (message.locationLng != null) compactMessage.locationLng = message.locationLng
          if (message.locationPoiname) compactMessage.locationPoiname = message.locationPoiname
          if (message.locationLabel) compactMessage.locationLabel = message.locationLabel
          if (message.appMsgType) compactMessage.appMsgType = message.appMsgType
          if (message.appMsgKind) compactMessage.appMsgKind = message.appMsgKind
          if (message.appMsgDesc) compactMessage.appMsgDesc = message.appMsgDesc
          if (message.appMsgAppName) compactMessage.appMsgAppName = message.appMsgAppName
          if (message.appMsgSourceName) compactMessage.appMsgSourceName = message.appMsgSourceName
          if (message.appMsgSourceUsername) compactMessage.appMsgSourceUsername = message.appMsgSourceUsername
          if (message.appMsgThumbUrl) compactMessage.appMsgThumbUrl = message.appMsgThumbUrl
          if (message.quotedContent) compactMessage.quotedContent = message.quotedContent
          if (message.quotedSender) compactMessage.quotedSender = message.quotedSender
          if (message.quotedType) compactMessage.quotedType = message.quotedType
          if (message.linkTitle) compactMessage.linkTitle = message.linkTitle
          if (message.linkUrl) compactMessage.linkUrl = message.linkUrl
          if (message.linkThumb) compactMessage.linkThumb = message.linkThumb
          if (message.emojiMd5) compactMessage.emojiMd5 = message.emojiMd5
          if (message.emojiCdnUrl) compactMessage.emojiCdnUrl = message.emojiCdnUrl
          if (message.emojiCaption) compactMessage.emojiCaption = message.emojiCaption
          if (message.finderTitle) compactMessage.finderTitle = message.finderTitle
          if (message.finderDesc) compactMessage.finderDesc = message.finderDesc
          if (message.finderUsername) compactMessage.finderUsername = message.finderUsername
          if (message.finderNickname) compactMessage.finderNickname = message.finderNickname
          if (message.finderCoverUrl) compactMessage.finderCoverUrl = message.finderCoverUrl
          if (message.finderAvatar) compactMessage.finderAvatar = message.finderAvatar
          if (message.finderDuration != null) compactMessage.finderDuration = message.finderDuration
          if (message.finderObjectId) compactMessage.finderObjectId = message.finderObjectId
          if (message.finderUrl) compactMessage.finderUrl = message.finderUrl
          if (message.musicTitle) compactMessage.musicTitle = message.musicTitle
          if (message.musicUrl) compactMessage.musicUrl = message.musicUrl
          if (message.musicDataUrl) compactMessage.musicDataUrl = message.musicDataUrl
          if (message.musicAlbumUrl) compactMessage.musicAlbumUrl = message.musicAlbumUrl
          if (message.musicCoverUrl) compactMessage.musicCoverUrl = message.musicCoverUrl
          if (message.musicSinger) compactMessage.musicSinger = message.musicSinger
          if (message.musicAppName) compactMessage.musicAppName = message.musicAppName
          if (message.musicSourceName) compactMessage.musicSourceName = message.musicSourceName
          if (message.musicDuration != null) compactMessage.musicDuration = message.musicDuration
          if (message.cardKind) compactMessage.cardKind = message.cardKind
          if (message.contactCardWxid) compactMessage.contactCardWxid = message.contactCardWxid
          if (message.contactCardNickname) compactMessage.contactCardNickname = message.contactCardNickname
          if (message.contactCardAlias) compactMessage.contactCardAlias = message.contactCardAlias
          if (message.contactCardRemark) compactMessage.contactCardRemark = message.contactCardRemark
          if (message.contactCardGender != null) compactMessage.contactCardGender = message.contactCardGender
          if (message.contactCardProvince) compactMessage.contactCardProvince = message.contactCardProvince
          if (message.contactCardCity) compactMessage.contactCardCity = message.contactCardCity
          if (message.contactCardSignature) compactMessage.contactCardSignature = message.contactCardSignature
          if (message.contactCardAvatar) compactMessage.contactCardAvatar = message.contactCardAvatar
          return compactMessage
        })

        const arkmeSession: any = {
          ...sessionPayload
        }
        let groupMembers: Array<{
          wxid: string
          displayName: string
          nickname: string
          remark: string
          alias: string
          groupNickname?: string
          isFriend: boolean
          messageCount: number
          avatar?: string
        }> | undefined

        if (isGroup) {
          const memberUsernames = Array.from(collected.memberSet.keys()).filter(Boolean)
          await this.exportService.preloadContacts(memberUsernames, contactCache)
          const friendLookupUsernames = buildGroupNicknameIdCandidates(memberUsernames)
          const friendFlagMap = await this.exportService.queryFriendFlagMap(friendLookupUsernames)
          const groupStatsResult = await wcdbService.getGroupStats(sessionId, 0, 0)
          const groupSenderCountMap = groupStatsResult.success && groupStatsResult.data
            ? this.exportService.extractGroupSenderCountMap(groupStatsResult.data, sessionId)
            : new Map<string, number>()

          groupMembers = []
          for (const memberWxid of memberUsernames) {
            this.exportService.throwIfStopRequested(control)
            const member = collected.memberSet.get(memberWxid)?.member
            const contactResult = await getContactCached(memberWxid)
            const contact = contactResult.success ? contactResult.contact : null
            const nickname = String(contact?.nickName || contact?.nick_name || member?.accountName || memberWxid)
            const remark = String(contact?.remark || '')
            const alias = String(contact?.alias || '')
            const groupNickname = member?.groupNickname || resolveGroupNicknameByCandidates(
              groupNicknamesMap,
              [memberWxid, contact?.username, contact?.userName, contact?.encryptUsername, contact?.encryptUserName, alias]
            ) || ''
            const displayName = getPreferredDisplayName(
              memberWxid,
              nickname,
              remark,
              groupNickname,
              options.displayNamePreference || 'remark'
            )

            const groupMember: {
              wxid: string
              displayName: string
              nickname: string
              remark: string
              alias: string
              groupNickname?: string
              isFriend: boolean
              messageCount: number
              avatar?: string
            } = {
              wxid: memberWxid,
              displayName,
              nickname,
              remark,
              alias,
              isFriend: buildGroupNicknameIdCandidates([memberWxid]).some((candidate: string) => friendFlagMap.get(candidate) === true),
              messageCount: this.exportService.sumSenderCountsByIdentity(groupSenderCountMap, memberWxid)
            }
            if (groupNickname) groupMember.groupNickname = groupNickname
            const avatar = avatarMap.get(memberWxid)
            if (avatar) groupMember.avatar = avatar
            groupMembers.push(groupMember)
          }
          groupMembers.sort((a, b) => {
            if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount
            return String(a.displayName || a.wxid).localeCompare(String(b.displayName || b.wxid), 'zh-CN')
          })
        }

        const arkmeExport: any = {
          weflow: {
            ...weflow,
            format: 'arkme-json'
          },
          session: arkmeSession,
          senders,
          messages: compactMessages
        }
        if (groupMembers) {
          arkmeExport.groupMembers = groupMembers
        }

        this.exportService.throwIfStopRequested(control)
        await this.exportService.recordCreatedFileBeforeWrite(outputPath, control)
        await fs.promises.writeFile(outputPath, JSON.stringify(arkmeExport, null, 2), 'utf-8')
      } else {
        const detailedExport: any = {
          weflow,
          session: sessionPayload,
          messages: allMessages
        }

        if (options.exportAvatars) {
          const avatars: Record<string, string> = {}
          for (const [username, relPath] of avatarMap.entries()) {
            avatars[username] = relPath
          }
          if (Object.keys(avatars).length > 0) {
            detailedExport.session = {
              ...detailedExport.session,
              avatar: avatars[sessionId]
            }
            ; (detailedExport as any).avatars = avatars
          }
        }

        this.exportService.throwIfStopRequested(control)
        await this.exportService.recordCreatedFileBeforeWrite(outputPath, control)
        await fs.promises.writeFile(outputPath, JSON.stringify(detailedExport, null, 2), 'utf-8')
      }

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
