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

export const exportChatLabMixin = {
  async exportSessionToChatLab(this: ExportServiceInstance, 
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
      const allMessages = collected.rows
      const totalMessages = allMessages.length

      // 如果没有消息,不创建文件
      if (totalMessages === 0) {
        return { success: false, error: await this.buildNoMessagesError(sessionId, collected) }
      }

      await this.hydrateEmojiCaptionsForMessages(sessionId, allMessages, control)

      const voiceMessages = options.exportVoiceAsText
        ? allMessages.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of allMessages) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      senderUsernames.add(cleanedMyWxid)
      await this.preloadContacts(senderUsernames, contactCache)

      if (isGroup) {
        this.throwIfStopRequested(control)
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }

      // ========== 获取群昵称并更新到 memberSet ==========
      const groupNicknameCandidates = isGroup
        ? buildGroupNicknameIdCandidates([
          ...Array.from(collected.memberSet.keys()),
          ...allMessages.map(msg => msg.senderUsername),
          cleanedMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      // 将群昵称更新到 memberSet 中
      if (isGroup && groupNicknamesMap.size > 0) {
        for (const [username, info] of collected.memberSet) {
          // 尝试多种方式查找群昵称（支持大小写）
          const groupNickname = this.resolveGroupNicknameByCandidates(groupNicknamesMap, [username]) || ''
          if (groupNickname) {
            info.member.groupNickname = groupNickname
          }
        }
      }

      const allMessagesInCursorOrder = allMessages

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 阶段1：并行导出媒体文件 ==========
      const mediaMessages = this.collectMediaMessagesForExport(allMessagesInCursorOrder, options)

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
          current: 20,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: this.formatMediaPhaseLabel(0, mediaMessages.length, beforeMediaDoneFiles),
          ...this.getMediaTelemetrySnapshot(),
          estimatedTotalMessages: totalMessages
        })

        // 并行导出媒体，并发数跟随导出设置
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
              current: 20,
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
          current: 40,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice',
          phaseProgress: 0,
          phaseTotal: voiceMessages.length,
          phaseLabel: `语音转文字 0/${voiceMessages.length}`,
          estimatedTotalMessages: totalMessages
        })

        // 并行转写语音，限制 4 个并发（转写比较耗资源）
        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(getStableMessageKey(msg), transcript)
          voiceTranscribed++
          onProgress?.({
            current: 40,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      // ========== 阶段3：构建消息列表 ==========
      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: 0
      })

      const chatLabMessages: ChatLabMessage[] = []
      const senderProfileMap = new Map<string, ExportDisplayProfile>()
      let messageIndex = 0
      for (const msg of allMessages) {
        if ((messageIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const memberInfo = collected.memberSet.get(msg.senderUsername)?.member || {
          platformId: msg.senderUsername,
          accountName: msg.senderUsername,
          groupNickname: undefined
        }

        // 如果 memberInfo 中没有群昵称，尝试从 groupNicknamesMap 获取
        const groupNickname = memberInfo.groupNickname
          || (isGroup ? this.resolveGroupNicknameByCandidates(groupNicknamesMap, [msg.senderUsername]) : '')
          || ''
        const senderProfile = isGroup
          ? await this.resolveExportDisplayProfile(
            msg.senderUsername || cleanedMyWxid,
            options.displayNamePreference,
            getContactCached,
            groupNicknamesMap,
            msg.isSend ? (myInfo.displayName || cleanedMyWxid) : (memberInfo.accountName || msg.senderUsername || ''),
            msg.isSend ? [rawMyWxid, cleanedMyWxid] : []
          )
          : {
            wxid: msg.senderUsername || cleanedMyWxid,
            nickname: memberInfo.accountName || msg.senderUsername || '',
            remark: '',
            alias: '',
            groupNickname,
            displayName: memberInfo.accountName || msg.senderUsername || ''
          }
        if (senderProfile.wxid && !senderProfileMap.has(senderProfile.wxid)) {
          senderProfileMap.set(senderProfile.wxid, senderProfile)
        }

        // 确定消息内容
        let content: string | null
        const mediaKey = getMediaCacheKey(msg)
        const mediaItem = mediaCache.get(mediaKey)
        if (msg.localType === 34 && options.exportVoiceAsText) {
          // 使用预先转写的文字
          content = voiceTranscriptMap.get(getStableMessageKey(msg)) || '[语音消息 - 转文字失败]'
        } else if (mediaItem && msg.localType === 3) {
          content = mediaItem.relativePath
        } else {
          content = this.parseMessageContent(
            msg.content,
            msg.localType,
            sessionId,
            msg.createTime,
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend,
            msg.emojiCaption
          )
        }
        if (this.isReadableSystemMessage(msg.localType, msg.content)) {
          content = this.extractReadableSystemMessageText(msg.content) || content
        }

        // 转账消息：追加 "谁转账给谁" 信息
        if (content && this.isTransferExportContent(content) && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            cleanedMyWxid,
            groupNicknamesMap,
            async (username) => {
              const info = await this.getContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            content = this.appendTransferDesc(content, transferDesc)
          }
        }

        const markdownLinkContent = this.formatLinkCardExportText(msg.content, msg.localType, 'markdown')
        if (markdownLinkContent) {
          content = markdownLinkContent
        }

        const message: ChatLabMessage = {
          sender: msg.senderUsername,
          accountName: senderProfile.displayName || memberInfo.accountName,
          groupNickname: (senderProfile.groupNickname || groupNickname) || undefined,
          timestamp: msg.createTime,
          type: this.convertMessageType(msg.localType, msg.content),
          content: content
        }

        const platformMessageId = normalizeUnsignedIntToken(msg.serverIdRaw ?? msg.serverId)
        if (platformMessageId !== '0') {
          message.platformMessageId = platformMessageId
        }

        const replyToMessageId = this.extractChatLabReplyToMessageId(msg.content)
        if (replyToMessageId) {
          message.replyToMessageId = replyToMessageId
        }

        // 如果有聊天记录，添加为嵌套字段
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          const chatRecords: any[] = []

          for (const record of msg.chatRecordList) {
            // 解析时间戳 (格式: "YYYY-MM-DD HH:MM:SS")
            let recordTimestamp = msg.createTime
            if (record.sourcetime) {
              try {
                const timeParts = record.sourcetime.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
                if (timeParts) {
                  const date = new Date(
                    parseInt(timeParts[1]),
                    parseInt(timeParts[2]) - 1,
                    parseInt(timeParts[3]),
                    parseInt(timeParts[4]),
                    parseInt(timeParts[5]),
                    parseInt(timeParts[6])
                  )
                  recordTimestamp = Math.floor(date.getTime() / 1000)
                }
              } catch (e) {
                console.error('解析聊天记录时间失败:', e)
              }
            }

            // 转换消息类型
            let recordType = 0 // TEXT
            let recordContent = record.datadesc || record.datatitle || ''

            switch (record.datatype) {
              case 1:
                recordType = 0 // TEXT
                break
              case 3:
                recordType = 1 // IMAGE
                recordContent = '[图片]'
                break
              case 8:
              case 49:
                recordType = 4 // FILE
                recordContent = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
                break
              case 34:
                recordType = 2 // VOICE
                recordContent = '[语音消息]'
                break
              case 43:
                recordType = 3 // VIDEO
                recordContent = '[视频]'
                break
              case 47:
                recordType = 5 // EMOJI
                recordContent = '[表情包]'
                break
              default:
                recordType = 0
                recordContent = record.datadesc || record.datatitle || '[消息]'
            }

            const chatRecord: any = {
              sender: record.sourcename || 'unknown',
              accountName: record.sourcename || 'unknown',
              timestamp: recordTimestamp,
              type: recordType,
              content: recordContent
            }

            // 添加头像（如果启用导出头像）
            if (options.exportAvatars && record.sourceheadurl) {
              chatRecord.avatar = record.sourceheadurl
            }

            chatRecords.push(chatRecord)

            // 添加成员信息到 memberSet
            if (record.sourcename && !collected.memberSet.has(record.sourcename)) {
              const newMember: ChatLabMember = {
                platformId: record.sourcename,
                accountName: record.sourcename
              }
              if (options.exportAvatars && record.sourceheadurl) {
                newMember.avatar = record.sourceheadurl
              }
              collected.memberSet.set(record.sourcename, {
                member: newMember,
                avatarUrl: record.sourceheadurl
              })
            }
          }

          message.chatRecords = chatRecords
        }

        chatLabMessages.push(message)
        if ((chatLabMessages.length % 200) === 0 || chatLabMessages.length === totalMessages) {
          const exportProgress = 60 + Math.floor((chatLabMessages.length / totalMessages) * 20)
          onProgress?.({
            current: exportProgress,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting',
            estimatedTotalMessages: totalMessages,
            collectedMessages: totalMessages,
            exportedMessages: chatLabMessages.length
          })
        }
      }

      const avatarMap = options.exportAvatars
        ? await this.exportAvatars(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl }
          ]
        )
        : new Map<string, string>()

      const sessionAvatar = avatarMap.get(sessionId)
      const members = await Promise.all(Array.from(collected.memberSet.values()).map(async (info) => {
        const profile = isGroup
          ? (senderProfileMap.get(info.member.platformId) || await this.resolveExportDisplayProfile(
            info.member.platformId,
            options.displayNamePreference,
            getContactCached,
            groupNicknamesMap,
            info.member.accountName || info.member.platformId,
            this.isSameWxid(info.member.platformId, cleanedMyWxid) ? [rawMyWxid, cleanedMyWxid] : []
          ))
          : null
        const member = profile
          ? {
            ...info.member,
            accountName: profile.displayName || info.member.accountName,
            groupNickname: profile.groupNickname || info.member.groupNickname
          }
          : info.member
        const avatar = avatarMap.get(info.member.platformId)
        return avatar ? { ...member, avatar } : member
      }))

      const { chatlab, meta } = this.getExportMeta(sessionId, sessionInfo, isGroup, sessionAvatar)

      const chatLabExport: ChatLabExport = {
        chatlab,
        meta,
        members,
        messages: chatLabMessages
      }

      onProgress?.({
        current: 80,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: totalMessages
      })

      if (options.format === 'chatlab-jsonl') {
        const lines: string[] = []
        lines.push(JSON.stringify({
          _type: 'header',
          chatlab: chatLabExport.chatlab,
          meta: chatLabExport.meta
        }))
        for (const member of chatLabExport.members) {
          this.throwIfStopRequested(control)
          lines.push(JSON.stringify({ _type: 'member', ...member }))
        }
        for (const message of chatLabExport.messages) {
          this.throwIfStopRequested(control)
          lines.push(JSON.stringify({ _type: 'message', ...message }))
        }
        this.throwIfStopRequested(control)
        await this.recordCreatedFileBeforeWrite(outputPath, control)
        await fs.promises.writeFile(outputPath, lines.join('\n'), 'utf-8')
      } else {
        this.throwIfStopRequested(control)
        await this.recordCreatedFileBeforeWrite(outputPath, control)
        await fs.promises.writeFile(outputPath, JSON.stringify(chatLabExport, null, 2), 'utf-8')
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
   * 导出单个会话为详细 JSON 格式（原项目格式）- 并行优化版本
   */,
}
