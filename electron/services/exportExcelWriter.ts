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
import ExcelJS from 'exceljs'

type ExportServiceInstance = ExportWriterHost

export const exportExcelMixin = {
  async exportSessionToExcel(this: ExportServiceInstance, 
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

      // 获取会话的备注信息
      const sessionContact = await getContactCached(sessionId)
      const sessionRemark = sessionContact.success && sessionContact.contact?.remark ? sessionContact.contact.remark : ''
      const sessionNickname = sessionContact.success && sessionContact.contact?.nickName ? sessionContact.contact.nickName : sessionId

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

      onProgress?.({
        current: 30,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: 0
      })

      // 创建 Excel 工作簿
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'WeFlow'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('聊天记录')

      let currentRow = 1

      const useCompactColumns = options.excelCompactColumns === true

      // 第一行：会话信息标题
      const titleCell = worksheet.getCell(currentRow, 1)
      titleCell.value = '会话信息'
      titleCell.font = { name: 'Calibri', bold: true, size: 11 }
      titleCell.alignment = { vertical: 'middle', horizontal: 'left' }
      worksheet.getRow(currentRow).height = 25
      currentRow++

      // 第二行：会话详细信息
      worksheet.getCell(currentRow, 1).value = '微信ID'
      worksheet.getCell(currentRow, 1).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.mergeCells(currentRow, 2, currentRow, 3)
      worksheet.getCell(currentRow, 2).value = sessionId
      worksheet.getCell(currentRow, 2).font = { name: 'Calibri', size: 11 }

      worksheet.getCell(currentRow, 4).value = '昵称'
      worksheet.getCell(currentRow, 4).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 5).value = sessionNickname
      worksheet.getCell(currentRow, 5).font = { name: 'Calibri', size: 11 }

      if (isGroup) {
        worksheet.getCell(currentRow, 6).value = '备注'
        worksheet.getCell(currentRow, 6).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.mergeCells(currentRow, 7, currentRow, 8)
        worksheet.getCell(currentRow, 7).value = sessionRemark
        worksheet.getCell(currentRow, 7).font = { name: 'Calibri', size: 11 }
      }
      worksheet.getRow(currentRow).height = 20
      currentRow++

      // 第三行：导出元数据
      const { chatlab, meta: exportMeta } = this.getExportMeta(sessionId, sessionInfo, isGroup)
      worksheet.getCell(currentRow, 1).value = '导出工具'
      worksheet.getCell(currentRow, 1).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 2).value = chatlab.generator
      worksheet.getCell(currentRow, 2).font = { name: 'Calibri', size: 10 }

      worksheet.getCell(currentRow, 3).value = '导出版本'
      worksheet.getCell(currentRow, 3).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 4).value = chatlab.version
      worksheet.getCell(currentRow, 4).font = { name: 'Calibri', size: 10 }

      worksheet.getCell(currentRow, 5).value = '平台'
      worksheet.getCell(currentRow, 5).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 6).value = exportMeta.platform
      worksheet.getCell(currentRow, 6).font = { name: 'Calibri', size: 10 }

      worksheet.getCell(currentRow, 7).value = '导出时间'
      worksheet.getCell(currentRow, 7).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 8).value = this.formatTimestamp(chatlab.exportedAt)
      worksheet.getCell(currentRow, 8).font = { name: 'Calibri', size: 10 }

      worksheet.getRow(currentRow).height = 20
      currentRow++

      // 表头行
      const includeGroupNicknameColumn = !useCompactColumns && isGroup
      const headers = useCompactColumns
        ? ['序号', '时间', '发送者身份', '消息类型', '内容']
        : includeGroupNicknameColumn
          ? ['序号', '时间', '发送者昵称', '发送者微信ID', '发送者备注', '群昵称', '发送者身份', '消息类型', '内容']
          : ['序号', '时间', '发送者昵称', '发送者微信ID', '发送者备注', '发送者身份', '消息类型', '内容']
      const headerRow = worksheet.getRow(currentRow)
      headerRow.height = 22

      headers.forEach((header, index) => {
        const cell = headerRow.getCell(index + 1)
        cell.value = header
        cell.font = { name: 'Calibri', bold: true, size: 11 }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE8F5E9' }
        }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
      })
      currentRow++

      // 设置列宽
      worksheet.getColumn(1).width = 8   // 序号
      worksheet.getColumn(2).width = 20  // 时间
      if (useCompactColumns) {
        worksheet.getColumn(3).width = 18  // 发送者身份
        worksheet.getColumn(4).width = 12  // 消息类型
        worksheet.getColumn(5).width = 50  // 内容
      } else {
        worksheet.getColumn(3).width = 18  // 发送者昵称
        worksheet.getColumn(4).width = 25  // 发送者微信ID
        worksheet.getColumn(5).width = 18  // 发送者备注
        if (includeGroupNicknameColumn) {
          worksheet.getColumn(6).width = 18  // 群昵称
          worksheet.getColumn(7).width = 15  // 发送者身份
          worksheet.getColumn(8).width = 12  // 消息类型
          worksheet.getColumn(9).width = 50  // 内容
        } else {
          worksheet.getColumn(6).width = 15  // 发送者身份
          worksheet.getColumn(7).width = 12  // 消息类型
          worksheet.getColumn(8).width = 50  // 内容
        }
      }

      // 预加载群昵称 (仅群聊且完整列模式)
      const groupNicknameCandidates = isGroup
        ? buildGroupNicknameIdCandidates([
          ...collected.rows.map(msg => msg.senderUsername),
          cleanedMyWxid,
          rawMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()


      // 填充数据
      const sortedMessages = collected.rows

      // 媒体导出设置
      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 并行预处理：媒体文件 ==========
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
          current: 35,
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
              current: 35,
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

      // ========== 并行预处理：语音转文字 ==========
      const voiceTranscriptMap = new Map<string, string>()

      if (voiceMessages.length > 0) {
        await this.preloadVoiceWavCache(sessionId, voiceMessages, control)

        onProgress?.({
          current: 50,
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
            current: 50,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      const shouldUseStreamingWriter = totalMessages > 20000
      if (shouldUseStreamingWriter) {
        return this.exportSessionToExcelStreaming({
          outputPath,
          options,
          sessionId,
          sessionInfo,
          myInfo,
          cleanedMyWxid,
          rawMyWxid,
          isGroup,
          sortedMessages,
          mediaCache,
          voiceTranscriptMap,
          getContactCached,
          groupNicknamesMap,
          onProgress,
          control,
          totalMessages
        })
      }

      onProgress?.({
        current: 65,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: 0
      })

      // ========== 写入 Excel 行 ==========
      const senderProfileCache = new Map<string, ExportDisplayProfile>()
      for (let i = 0; i < totalMessages; i++) {
        if ((i & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]

        // 确定发送者信息
        let senderRole: string
        let senderWxid: string
        let senderNickname: string
        let senderRemark: string = ''
        let senderGroupNickname: string = ''  // 群昵称

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
          senderGroupNickname = senderProfile.groupNickname
          senderRole = senderProfile.displayName
        } else if (msg.isSend) {
          // 我发送的消息
          senderRole = '我'
          senderWxid = cleanedMyWxid
          senderNickname = myInfo.displayName || cleanedMyWxid
          senderRemark = ''
        } else {
          // 单聊对方消息 - 用 getContact 获取联系人详情
          senderWxid = sessionId
          const contactDetail = await getContactCached(sessionId)
          if (contactDetail.success && contactDetail.contact) {
            senderNickname = contactDetail.contact.nickName || sessionId
            senderRemark = contactDetail.contact.remark || ''
            senderRole = senderRemark || senderNickname
          } else {
            senderNickname = sessionInfo.displayName || sessionId
            senderRemark = ''
            senderRole = senderNickname
          }
        }

        const row = worksheet.getRow(currentRow)
        row.height = 24

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

        const contentCellIndex = useCompactColumns ? 5 : (includeGroupNicknameColumn ? 9 : 8)
        const contentCell = worksheet.getCell(currentRow, contentCellIndex)

        worksheet.getCell(currentRow, 1).value = i + 1
        worksheet.getCell(currentRow, 2).value = this.formatTimestamp(msg.createTime)
        if (useCompactColumns) {
          worksheet.getCell(currentRow, 3).value = senderRole
          worksheet.getCell(currentRow, 4).value = this.getMessageTypeName(msg.localType, msg.content)
        } else if (includeGroupNicknameColumn) {
          worksheet.getCell(currentRow, 3).value = senderNickname
          worksheet.getCell(currentRow, 4).value = senderWxid
          worksheet.getCell(currentRow, 5).value = senderRemark
          worksheet.getCell(currentRow, 6).value = senderGroupNickname
          worksheet.getCell(currentRow, 7).value = senderRole
          worksheet.getCell(currentRow, 8).value = this.getMessageTypeName(msg.localType, msg.content)
        } else {
          worksheet.getCell(currentRow, 3).value = senderNickname
          worksheet.getCell(currentRow, 4).value = senderWxid
          worksheet.getCell(currentRow, 5).value = senderRemark
          worksheet.getCell(currentRow, 6).value = senderRole
          worksheet.getCell(currentRow, 7).value = this.getMessageTypeName(msg.localType, msg.content)
        }
        contentCell.value = enrichedContentValue
        if (!quotedReplyDisplay) {
          this.applyExcelLinkCardCell(contentCell, msg.content, msg.localType)
        }

        currentRow++

        // 每处理 100 条消息报告一次进度
        if ((i + 1) % 100 === 0) {
          const progress = 30 + Math.floor((i + 1) / sortedMessages.length * 50)
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

      onProgress?.({
        current: 90,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: totalMessages
      })

      // 写入文件
      this.throwIfStopRequested(control)
      await this.recordCreatedFileBeforeWrite(outputPath, control)
      await workbook.xlsx.writeFile(outputPath)

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
      // 处理文件被占用的错误
      if (e instanceof Error) {
        if (e.message.includes('EBUSY') || e.message.includes('resource busy') || e.message.includes('locked')) {
          return { success: false, error: '文件已经打开，请关闭后再导出' }
        }
      }

      return { success: false, error: String(e) }
    }
  }
,
}
