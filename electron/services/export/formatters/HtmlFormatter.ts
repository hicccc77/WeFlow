import * as fs from 'fs';
import * as path from 'path';
//  '../../wcdbService';
import { getAvatarFallback } from '../../export/contacts/avatarHelper';
import { resolveExportDisplayProfile } from '../../export/contacts/contactResolver';
import { buildGroupNicknameIdCandidates } from '../../export/contacts/groupNickname';
import { appendTransferDesc, isTransferExportContent, resolveTransferDesc } from '../../export/parsers/transferParser';
import { escapeAttribute, escapeHtml } from '../../export/utils/htmlEscape';
import { formatTimestamp } from '../../export/utils/timestamp';

import { parallelLimit } from '../../export/utils/parallelLimit';
import {  ExportDisplayProfile, MediaExportItem  } from '../../export/types';
import { wcdbService } from "../../wcdbService";

export class HtmlFormatter {
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

      if (options.exportVoiceAsText) {
        await this.exportService.ensureVoiceModel(onProgress)
      }

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

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: await this.exportService.buildNoMessagesError(sessionId, collected) }
      }
      const totalMessages = collected.rows.length
      await this.exportService.createWeliveRawOutputPlaceholder(outputPath, control)

      await this.exportService.hydrateEmojiCaptionsForMessages(sessionId, collected.rows, control)

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

      if (isGroup) {
        this.exportService.throwIfStopRequested(control)
        await this.exportService.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }
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
          current: 20,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: this.exportService.formatMediaPhaseLabel(0, mediaMessages.length, beforeMediaDoneFiles),
          ...this.exportService.getMediaTelemetrySnapshot(),
          estimatedTotalMessages: totalMessages
        })

        const MEDIA_CONCURRENCY = 6
        let mediaExported = 0
        await parallelLimit(mediaMessages, MEDIA_CONCURRENCY, async (msg: any) => {
          this.exportService.throwIfStopRequested(control)
          const mediaKey = this.exportService.getMediaCacheKey(msg)
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportService.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportEmojis: options.exportEmojis,
              exportFiles: options.exportFiles,
              maxFileSizeMb: options.maxFileSizeMb,
              exportVoiceAsText: options.exportVoiceAsText,
              exportConflictStrategy: options.exportConflictStrategy,
              includeVideoPoster: options.format === 'html',
              includeVoiceWithTranscript: true,
              exportVideos: options.exportVideos,
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
              phaseLabel: this.exportService.formatMediaPhaseLabel(mediaExported, mediaMessages.length, beforeMediaDoneFiles),
              ...this.exportService.getMediaTelemetrySnapshot()
            })
          }
        })
      }
      await this.exportService.preloadWeliveRawEmojiMedia(sortedMessages, mediaCache, mediaRootDir, mediaRelativePrefix, options, control, onProgress, sessionInfo.displayName, 20)
      const fileOnlyExportFailure = this.exportService.buildFileOnlyExportFailure(options, mediaMessages, beforeMediaDoneFiles)
      if (fileOnlyExportFailure) return fileOnlyExportFailure

      const useVoiceTranscript = options.exportVoiceAsText === true
      const voiceMessages = useVoiceTranscript
        ? sortedMessages.filter((msg: any) => msg.localType === 34)
        : []
      const voiceTranscriptMap = new Map<string, string>()

      if (voiceMessages.length > 0) {
        await this.exportService.preloadVoiceWavCache(sessionId, voiceMessages, control)

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

        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg: any) => {
          this.exportService.throwIfStopRequested(control)
          const transcript = await this.exportService.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername, msg.serverIdRaw || msg.serverId)
          voiceTranscriptMap.set(this.exportService.getStableMessageKey(msg), transcript)
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

      const avatarMap = options.exportAvatars
        ? await this.exportService.exportAvatarsToFiles(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]: [string, any]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl },
            { username: cleanedMyWxid, avatarUrl: myInfo.avatarUrl }
          ],
          path.dirname(outputPath),
          control
        )
        : new Map<string, string>()

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: 0
      })

      // ================= BEGIN STREAM WRITING =================
      const exportMeta = this.exportService.getExportMeta(sessionId, sessionInfo, isGroup)
      const htmlStyles = this.exportService.loadExportHtmlStyles()
      await this.exportService.recordCreatedFileBeforeWrite(outputPath, control)
      const stream = fs.createWriteStream(outputPath, { encoding: 'utf-8' })

      const writePromise = (str: string) => {
        return new Promise<void>((resolve, reject) => {
          this.exportService.throwIfStopRequested(control)
          if (!stream.write(str)) {
            stream.once('drain', resolve)
          } else {
            resolve()
          }
        })
      }

      await writePromise(`<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(sessionInfo.displayName)} - 聊天记录</title>
    <style>${htmlStyles}</style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <h1 class="title">${escapeHtml(sessionInfo.displayName)}</h1>
        <div class="meta">
          <span>${sortedMessages.length} 条消息</span>
          <span>${isGroup ? '群聊' : '私聊'}</span>
          <span>${escapeHtml(formatTimestamp(exportMeta.chatlab.exportedAt))}</span>
        </div>
        <div class="controls">
          <input id="searchInput" type="search" placeholder="搜索消息..." />
          <input id="timeInput" type="datetime-local" />
          <button id="jumpBtn" type="button">跳转</button>
          <div class="stats">
            <span id="resultCount">共 ${sortedMessages.length} 条</span>
          </div>
        </div>
      </div>
      
      <div id="scrollContainer" class="scroll-container"></div>
      
    </div>
    
    <div class="image-preview" id="imagePreview">
      <img id="imagePreviewTarget" alt="预览" />
    </div>

    <!-- Data Injection -->
    <script>
      window.WEFLOW_DATA = [
`);

      // Pre-build avatar HTML lookup to avoid per-message rebuilds
      const avatarHtmlCache = new Map<string, string>()
      const senderProfileCache = new Map<string, ExportDisplayProfile>()
      const getAvatarHtml = (username: string, name: string): string => {
        const cached = avatarHtmlCache.get(username)
        if (cached !== undefined) return cached
        const avatarData = avatarMap.get(username)
        const html = avatarData
          ? `<img src="${escapeAttribute(encodeURI(avatarData))}" alt="${escapeAttribute(name)}" />`
          : `<span>${escapeHtml(getAvatarFallback(name))}</span>`
        avatarHtmlCache.set(username, html)
        return html
      }

      // Write messages in buffered chunks
      const WRITE_BATCH = 100
      let writeBuf: string[] = []

      for (let i = 0; i < totalMessages; i++) {
        if ((i & 0x7f) === 0) {
          this.exportService.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]
        const mediaKey = this.exportService.getMediaCacheKey(msg)
        const mediaItem = mediaCache.has(mediaKey)
          ? mediaCache.get(mediaKey)
          : await this.exportService.resolveWeliveRawMediaItem(msg, mediaRootDir, mediaRelativePrefix, options, control)

        const isSenderMe = msg.isSend
        const senderInfo = collected.memberSet.get(msg.senderUsername)?.member
        const senderName = isGroup
          ? (() => {
            const senderKey = `${isSenderMe ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid)}::${isSenderMe ? '1' : '0'}`
            const cached = senderProfileCache.get(senderKey)
            if (cached) return cached.displayName
            return ''
          })()
          : (isSenderMe ? (myInfo.displayName || '我') : (sessionInfo.displayName || sessionId))
        const resolvedSenderName = isGroup && !senderName
          ? (await (async () => {
            const senderKey = `${isSenderMe ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid)}::${isSenderMe ? '1' : '0'}`
            const profile = await resolveExportDisplayProfile(
              isSenderMe ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid),
              options.displayNamePreference,
              getContactCached,
              groupNicknamesMap,
              isSenderMe ? (myInfo.displayName || cleanedMyWxid) : (senderInfo?.accountName || msg.senderUsername || ''),
              isSenderMe ? [rawMyWxid, cleanedMyWxid] : []
            )
            senderProfileCache.set(senderKey, profile)
            return profile.displayName
          })())
          : senderName

        const avatarHtml = getAvatarHtml(isSenderMe ? cleanedMyWxid : msg.senderUsername, resolvedSenderName)

        const timeText = formatTimestamp(msg.createTime)
        const typeName = this.exportService.getMessageTypeName(msg.localType, msg.content)
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

        let textContent = quotedReplyDisplay?.replyText || this.exportService.formatHtmlMessageText(
          msg.content,
          msg.localType,
          cleanedMyWxid,
          msg.senderUsername,
          msg.isSend,
          msg.emojiCaption
        )
        if (msg.localType === 34 && useVoiceTranscript) {
          textContent = voiceTranscriptMap.get(this.exportService.getStableMessageKey(msg)) || '[语音消息 - 转文字失败]'
        }
        if (mediaItem && msg.localType === 3) {
          textContent = ''
        }
        if (isTransferExportContent(textContent) && msg.content) {
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
            textContent = appendTransferDesc(textContent, transferDesc)
          }
        }

        const linkCard = quotedReplyDisplay ? null : this.exportService.extractHtmlLinkCard(msg.content, msg.localType)

        let mediaHtml = ''
        if (mediaItem?.kind === 'image') {
          const mediaPath = escapeAttribute(encodeURI(this.exportService.formatExportMediaPath(mediaItem.relativePath, options, 'url')))
          mediaHtml = `<img class="message-media image previewable" src="${mediaPath}" data-full="${mediaPath}" alt="${escapeAttribute(typeName)}" />`
        } else if (mediaItem?.kind === 'emoji') {
          const mediaPath = escapeAttribute(encodeURI(this.exportService.formatExportMediaPath(mediaItem.relativePath, options, 'url')))
          mediaHtml = `<img class="message-media emoji previewable" src="${mediaPath}" data-full="${mediaPath}" alt="${escapeAttribute(typeName)}" />`
        } else if (mediaItem?.kind === 'voice') {
          mediaHtml = `<audio class="message-media audio" controls src="${escapeAttribute(encodeURI(this.exportService.formatExportMediaPath(mediaItem.relativePath, options, 'url')))}"></audio>`
        } else if (mediaItem?.kind === 'video') {
          const posterAttr = mediaItem.posterDataUrl ? ` poster="${escapeAttribute(mediaItem.posterDataUrl)}"` : ''
          mediaHtml = `<video class="message-media video" controls preload="metadata"${posterAttr} src="${escapeAttribute(encodeURI(this.exportService.formatExportMediaPath(mediaItem.relativePath, options, 'url')))}"></video>`
        } else if (mediaItem?.kind === 'file') {
          const mediaPath = escapeAttribute(encodeURI(this.exportService.formatExportMediaPath(mediaItem.relativePath, options, 'url')))
          const fileName = escapeHtml(path.basename(mediaItem.relativePath.replace(/\\/g, '/')) || '文件附件')
          mediaHtml = `<a class="message-media file" href="${mediaPath}" target="_blank" rel="noopener noreferrer">${fileName}</a>`
        }

        const textHtml = quotedReplyDisplay
          ? (() => {
            const quotedSenderHtml = quotedReplyDisplay.quotedSender
              ? `<div class="quoted-sender">${escapeHtml(quotedReplyDisplay.quotedSender)}</div>`
              : ''
            const quotedPreviewHtml = `<div class="quoted-text">${this.exportService.renderTextWithEmoji(quotedReplyDisplay.quotedPreview).replace(/\r?\n/g, '<br />')}</div>`
            const replyTextHtml = textContent
              ? `<div class="message-text">${this.exportService.renderTextWithEmoji(textContent).replace(/\r?\n/g, '<br />')}</div>`
              : ''
            return `<div class="quoted-message">${quotedSenderHtml}${quotedPreviewHtml}</div>${replyTextHtml}`
          })()
          : (linkCard
            ? `<div class="message-text"><a class="message-link-card" href="${escapeAttribute(linkCard.url)}" target="_blank" rel="noopener noreferrer">${this.exportService.renderTextWithEmoji(linkCard.title).replace(/\r?\n/g, '<br />')}</a></div>`
            : (textContent
              ? `<div class="message-text">${this.exportService.renderTextWithEmoji(textContent).replace(/\r?\n/g, '<br />')}</div>`
              : ''))
        const senderNameHtml = isGroup
          ? `<div class="sender-name">${escapeHtml(resolvedSenderName)}</div>`
          : ''
        const timeHtml = `<div class="message-time">${escapeHtml(timeText)}</div>`
        const messageBody = `${timeHtml}${senderNameHtml}<div class="message-content">${mediaHtml}${textHtml}</div>`
        const platformMessageId = this.exportService.getExportPlatformMessageId(msg)
        const replyToMessageId = this.exportService.getExportReplyToMessageId(msg.content)

        // Compact JSON object
        const itemObj: Record<string, any> = {
          i: i + 1, // index
          t: msg.createTime, // timestamp
          s: isSenderMe ? 1 : 0, // isSend
          a: avatarHtml, // avatar HTML
          b: messageBody // body HTML
        }
        if (platformMessageId) itemObj.p = platformMessageId
        if (replyToMessageId) itemObj.r = replyToMessageId

        writeBuf.push(JSON.stringify(itemObj))

        // Flush buffer periodically
        if (writeBuf.length >= WRITE_BATCH || i === sortedMessages.length - 1) {
          const isLast = i === sortedMessages.length - 1
          const chunk = writeBuf.join(',\n') + (isLast ? '\n' : ',\n')
          await writePromise(chunk)
          writeBuf = []
        }

        // Report progress occasionally
        if ((i + 1) % 500 === 0) {
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

      await writePromise(`];
    </script>

    <script>
       ${this.exportService.getVirtualScrollScript()}

      const searchInput = document.getElementById('searchInput')
      const timeInput = document.getElementById('timeInput')
      const jumpBtn = document.getElementById('jumpBtn')
      const resultCount = document.getElementById('resultCount')
      const imagePreview = document.getElementById('imagePreview')
      const imagePreviewTarget = document.getElementById('imagePreviewTarget')
      const container = document.getElementById('scrollContainer')
      let imageZoom = 1

      // Initial Data
      let allData = window.WEFLOW_DATA || [];
      let currentList = allData;

      // Render Item Function
      const renderItem = (item, index) => {
         const isSenderMe = item.s === 1;
         const platformIdAttr = item.p ? \` data-platform-message-id="\${item.p}"\` : '';
         const replyToAttr = item.r ? \` data-reply-to-message-id="\${item.r}"\` : '';
         return \`
          <div class="message \${isSenderMe ? 'sent' : 'received'}" data-index="\${item.i}"\${platformIdAttr}\${replyToAttr}>
            <div class="message-row">
              <div class="avatar">\${item.a}</div>
              <div class="bubble">
                \${item.b}
              </div>
            </div>
          </div>
         \`;
      };
      
      const renderer = new ChunkedRenderer(container, currentList, renderItem);

      const updateCount = () => {
        resultCount.textContent = \`共 \${currentList.length} 条\`
      }

      // Search Logic
      let searchTimeout;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          const keyword = searchInput.value.trim().toLowerCase();
          if (!keyword) {
            currentList = allData;
          } else {
            currentList = allData.filter(item => {
               return item.b.toLowerCase().includes(keyword); 
            });
          }
          renderer.setData(currentList);
          updateCount();
        }, 300);
      })

      // Jump Logic
      jumpBtn.addEventListener('click', () => {
        const value = timeInput.value
        if (!value) return
        const target = Math.floor(new Date(value).getTime() / 1000)
        renderer.scrollToTime(target);
      })

      // Image Preview (Delegation)
      container.addEventListener('click', (e) => {
        const target = e.target;
        if (target.classList.contains('previewable')) {
           const full = target.getAttribute('data-full')
           if (!full) return
           imagePreviewTarget.src = full
           imageZoom = 1
           imagePreviewTarget.style.transform = 'scale(1)'
           imagePreview.classList.add('active')
        }
      });

      imagePreviewTarget.addEventListener('click', (event) => {
        event.stopPropagation()
      })

      imagePreviewTarget.addEventListener('dblclick', (event) => {
        event.stopPropagation()
        imageZoom = 1
        imagePreviewTarget.style.transform = 'scale(1)'
      })

      imagePreviewTarget.addEventListener('wheel', (event) => {
        event.preventDefault()
        const delta = event.deltaY > 0 ? -0.1 : 0.1
        imageZoom = Math.min(3, Math.max(0.5, imageZoom + delta))
        imagePreviewTarget.style.transform = \`scale(\${imageZoom})\`
      }, { passive: false })

      imagePreview.addEventListener('click', () => {
        imagePreview.classList.remove('active')
        imagePreviewTarget.src = ''
        imageZoom = 1
        imagePreviewTarget.style.transform = 'scale(1)'
      })

      updateCount()
    </script>
  </body>
</html>`);

      return new Promise((resolve, reject) => {
        stream.on('error', (err) => {
          // 确保在流错误时销毁流，释放文件句柄
          stream.destroy()
          reject(err)
        })
        
        stream.end(() => {
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
          resolve({ success: true })
        })
        stream.on('error', reject)
      })

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
