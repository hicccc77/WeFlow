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

export const exportJsonMixin = {
  async exportSessionToDetailedJson(this: ExportServiceInstance, 
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
      const senderInfoMap = await this.preloadContactInfos([
        ...Array.from(senderUsernames.values()),
        cleanedMyWxid
      ])

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 阶段1：并行导出媒体文件 ==========
      const mediaMessages = this.collectMediaMessagesForExport(collected.rows, options)

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
          current: 15,
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
              current: 15,
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

      // ========== 阶段2：并行语音转文字 ==========
      const voiceTranscriptMap = new Map<string, string>()

      if (voiceMessages.length > 0) {
        await this.preloadVoiceWavCache(sessionId, voiceMessages, control)

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
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(getStableMessageKey(msg), transcript)
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
          ...collected.rows.map(msg => msg.senderUsername),
          cleanedMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
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
          this.throwIfStopRequested(control)
        }
        const senderInfo = senderInfoMap.get(msg.senderUsername) || { displayName: msg.senderUsername || '' }
        const sourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(msg.content || '')
        const source = sourceMatch ? sourceMatch[0] : ''

        let content: string | null
        const mediaKey = getMediaCacheKey(msg)
        const mediaItem = mediaCache.get(mediaKey)

        if (msg.localType === 34 && options.exportVoiceAsText) {
          content = voiceTranscriptMap.get(getStableMessageKey(msg)) || '[语音消息 - 转文字失败]'
        } else if (mediaItem && msg.localType !== 47) {
          content = mediaItem.relativePath
        } else {
          content = this.parseMessageContent(
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
        if (this.isReadableSystemMessage(msg.localType, msg.content)) {
          content = this.extractReadableSystemMessageText(msg.content) || content
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
        // 对于媒体消息，不要让引用信息覆盖媒体路径
        if (quotedReplyDisplay && !mediaItem) {
          content = this.buildQuotedReplyText(quotedReplyDisplay)
        }

        const appendedLinkContent = quotedReplyDisplay
          ? null
          : this.formatLinkCardExportText(msg.content, msg.localType, 'append-url')
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
        const senderGroupNickname = this.resolveGroupNicknameByCandidates(groupNicknamesMap, [senderWxid])

        // 使用用户偏好的显示名称
        const senderDisplayName = this.getPreferredDisplayName(
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
          formattedTime: this.formatTimestamp(msg.createTime),
          type: this.getMessageTypeName(msg.localType, msg.content),
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

        const platformMessageId = this.getExportPlatformMessageId(msg)
        if (platformMessageId) msgObj.platformMessageId = platformMessageId

        const replyToMessageId = this.getExportReplyToMessageId(msg.content)
        if (replyToMessageId) msgObj.replyToMessageId = replyToMessageId

        const appMsgMeta = this.extractArkmeAppMessageMeta(msg.content, msg.localType)
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
          const contactCardMeta = this.extractArkmeContactCardMeta(msg.content, msg.localType)
          if (contactCardMeta) {
            Object.assign(msgObj, contactCardMeta)
          }
        }

        if (content && this.isTransferExportContent(content) && msg.content) {
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
            const contactResult = contactCache.get(username) ?? await getContactCached(username)
            if (contactResult.success && contactResult.contact) {
              return contactResult.contact.remark || contactResult.contact.nickName || contactResult.contact.alias || username
            }
            return username
          })()
          transferNamePromiseCache.set(username, task)
          const resolved = await task
          transferNamePromiseCache.delete(username)
          transferNameCache.set(username, resolved)
          return resolved
        }

        const transferConcurrency = getClampedConcurrency(options.exportConcurrency, 4, 8)
        await parallelLimit(transferCandidates, transferConcurrency, async (item) => {
          this.throwIfStopRequested(control)
          const transferDesc = await this.resolveTransferDesc(
            item.xml,
            cleanedMyWxid,
            groupNicknamesMap,
            resolveDisplayNameByUsername
          )
          if (transferDesc && typeof item.messageRef.content === 'string') {
            item.messageRef.content = this.appendTransferDesc(item.messageRef.content, transferDesc)
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
        ? this.resolveGroupNicknameByCandidates(groupNicknamesMap, [sessionId])
        : ''

      // 使用用户偏好的显示名称
      const sessionDisplayName = this.getPreferredDisplayName(
        sessionId,
        sessionNickname,
        sessionRemark,
        sessionGroupNickname,
        options.displayNamePreference || 'remark'
      )

      const weflow = this.getWeflowHeader()
      if (options.format === 'arkme-json' && isGroup) {
        this.throwIfStopRequested(control)
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }

      const avatarMap = options.exportAvatars
        ? await this.exportAvatars(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
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
          this.throwIfStopRequested(control)
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
          await this.preloadContacts(memberUsernames, contactCache)
          const friendLookupUsernames = buildGroupNicknameIdCandidates(memberUsernames)
          const friendFlagMap = await this.queryFriendFlagMap(friendLookupUsernames)
          const groupStatsResult = await wcdbService.getGroupStats(sessionId, 0, 0)
          const groupSenderCountMap = groupStatsResult.success && groupStatsResult.data
            ? this.extractGroupSenderCountMap(groupStatsResult.data, sessionId)
            : new Map<string, number>()

          groupMembers = []
          for (const memberWxid of memberUsernames) {
            this.throwIfStopRequested(control)
            const member = collected.memberSet.get(memberWxid)?.member
            const contactResult = await getContactCached(memberWxid)
            const contact = contactResult.success ? contactResult.contact : null
            const nickname = String(contact?.nickName || contact?.nick_name || member?.accountName || memberWxid)
            const remark = String(contact?.remark || '')
            const alias = String(contact?.alias || '')
            const groupNickname = member?.groupNickname || this.resolveGroupNicknameByCandidates(
              groupNicknamesMap,
              [memberWxid, contact?.username, contact?.userName, contact?.encryptUsername, contact?.encryptUserName, alias]
            ) || ''
            const displayName = this.getPreferredDisplayName(
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
              isFriend: buildGroupNicknameIdCandidates([memberWxid]).some((candidate) => friendFlagMap.get(candidate) === true),
              messageCount: this.sumSenderCountsByIdentity(groupSenderCountMap, memberWxid)
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

        this.throwIfStopRequested(control)
        await this.recordCreatedFileBeforeWrite(outputPath, control)
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

        this.throwIfStopRequested(control)
        await this.recordCreatedFileBeforeWrite(outputPath, control)
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
   * 导出单个会话为 Excel 格式（参考 echotrace 格式）
   */,
}
