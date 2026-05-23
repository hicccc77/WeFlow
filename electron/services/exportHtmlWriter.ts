// @ts-nocheck
import * as fs from 'fs'
import * as path from 'path'
import type { ExportWriterHost } from './exportWriterContext'
import { isStopError, isPauseError, buildGroupNicknameIdCandidates, getClampedConcurrency, getMediaCacheKey, getStableMessageKey, normalizeUnsignedIntToken, normalizeSessionIds, pathExists, escapeHtml, getVirtualScrollScript } from './exportServiceUtils'
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
import { EXPORT_HTML_STYLES } from './exportHtmlStyles'

type ExportServiceInstance = ExportWriterHost

export const exportHtmlMixin = {
  async exportSessionToHtml(this: ExportServiceInstance, 
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

      if (options.exportVoiceAsText) {
        await this.ensureVoiceModel(onProgress)
      }

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

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: await this.buildNoMessagesError(sessionId, collected) }
      }
      const totalMessages = collected.rows.length

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

      if (isGroup) {
        this.throwIfStopRequested(control)
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }
      const sortedMessages = collected.rows

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

        const MEDIA_CONCURRENCY = 6
        let mediaExported = 0
        await parallelLimit(mediaMessages, MEDIA_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const mediaKey = getMediaCacheKey(msg)
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportEmojis: options.exportEmojis,
              exportFiles: options.exportFiles,
              maxFileSizeMb: options.maxFileSizeMb,
              exportVoiceAsText: options.exportVoiceAsText,
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
              phaseLabel: this.formatMediaPhaseLabel(mediaExported, mediaMessages.length, beforeMediaDoneFiles),
              ...this.getMediaTelemetrySnapshot()
            })
          }
        })
      }
      const fileOnlyExportFailure = this.buildFileOnlyExportFailure(options, mediaMessages, beforeMediaDoneFiles)
      if (fileOnlyExportFailure) return fileOnlyExportFailure

      const useVoiceTranscript = options.exportVoiceAsText === true
      const voiceMessages = useVoiceTranscript
        ? sortedMessages.filter(msg => msg.localType === 34)
        : []
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

      const avatarMap = options.exportAvatars
        ? await this.exportAvatarsToFiles(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
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
      const exportMeta = this.getExportMeta(sessionId, sessionInfo, isGroup)
      const htmlStyles = this.loadExportHtmlStyles()
      await this.recordCreatedFileBeforeWrite(outputPath, control)
      const stream = fs.createWriteStream(outputPath, { encoding: 'utf-8' })

      const writePromise = (str: string) => {
        return new Promise<void>((resolve, reject) => {
          this.throwIfStopRequested(control)
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
          <span>${escapeHtml(this.formatTimestamp(exportMeta.chatlab.exportedAt))}</span>
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
          ? `<img src="${this.escapeAttribute(encodeURI(avatarData))}" alt="${this.escapeAttribute(name)}" />`
          : `<span>${escapeHtml(this.getAvatarFallback(name))}</span>`
        avatarHtmlCache.set(username, html)
        return html
      }

      // Write messages in buffered chunks
      const WRITE_BATCH = 100
      let writeBuf: string[] = []

      for (let i = 0; i < totalMessages; i++) {
        if ((i & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]
        const mediaKey = getMediaCacheKey(msg)
        const mediaItem = mediaCache.get(mediaKey) || null

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
            const profile = await this.resolveExportDisplayProfile(
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

        const timeText = this.formatTimestamp(msg.createTime)
        const typeName = this.getMessageTypeName(msg.localType, msg.content)
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

        let textContent = quotedReplyDisplay?.replyText || this.formatHtmlMessageText(
          msg.content,
          msg.localType,
          cleanedMyWxid,
          msg.senderUsername,
          msg.isSend,
          msg.emojiCaption
        )
        if (msg.localType === 34 && useVoiceTranscript) {
          textContent = voiceTranscriptMap.get(getStableMessageKey(msg)) || '[语音消息 - 转文字失败]'
        }
        if (mediaItem && msg.localType === 3) {
          textContent = ''
        }
        if (this.isTransferExportContent(textContent) && msg.content) {
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
            textContent = this.appendTransferDesc(textContent, transferDesc)
          }
        }

        const linkCard = quotedReplyDisplay ? null : this.extractHtmlLinkCard(msg.content, msg.localType)

        let mediaHtml = ''
        if (mediaItem?.kind === 'image') {
          const mediaPath = this.escapeAttribute(encodeURI(mediaItem.relativePath))
          mediaHtml = `<img class="message-media image previewable" src="${mediaPath}" data-full="${mediaPath}" alt="${this.escapeAttribute(typeName)}" />`
        } else if (mediaItem?.kind === 'emoji') {
          const mediaPath = this.escapeAttribute(encodeURI(mediaItem.relativePath))
          mediaHtml = `<img class="message-media emoji previewable" src="${mediaPath}" data-full="${mediaPath}" alt="${this.escapeAttribute(typeName)}" />`
        } else if (mediaItem?.kind === 'voice') {
          mediaHtml = `<audio class="message-media audio" controls src="${this.escapeAttribute(encodeURI(mediaItem.relativePath))}"></audio>`
        } else if (mediaItem?.kind === 'video') {
          const posterAttr = mediaItem.posterDataUrl ? ` poster="${this.escapeAttribute(mediaItem.posterDataUrl)}"` : ''
          mediaHtml = `<video class="message-media video" controls preload="metadata"${posterAttr} src="${this.escapeAttribute(encodeURI(mediaItem.relativePath))}"></video>`
        }

        const textHtml = quotedReplyDisplay
          ? (() => {
            const quotedSenderHtml = quotedReplyDisplay.quotedSender
              ? `<div class="quoted-sender">${escapeHtml(quotedReplyDisplay.quotedSender)}</div>`
              : ''
            const quotedPreviewHtml = `<div class="quoted-text">${this.renderTextWithEmoji(quotedReplyDisplay.quotedPreview).replace(/\r?\n/g, '<br />')}</div>`
            const replyTextHtml = textContent
              ? `<div class="message-text">${this.renderTextWithEmoji(textContent).replace(/\r?\n/g, '<br />')}</div>`
              : ''
            return `<div class="quoted-message">${quotedSenderHtml}${quotedPreviewHtml}</div>${replyTextHtml}`
          })()
          : (linkCard
            ? `<div class="message-text"><a class="message-link-card" href="${this.escapeAttribute(linkCard.url)}" target="_blank" rel="noopener noreferrer">${this.renderTextWithEmoji(linkCard.title).replace(/\r?\n/g, '<br />')}</a></div>`
            : (textContent
              ? `<div class="message-text">${this.renderTextWithEmoji(textContent).replace(/\r?\n/g, '<br />')}</div>`
              : ''))
        const senderNameHtml = isGroup
          ? `<div class="sender-name">${escapeHtml(resolvedSenderName)}</div>`
          : ''
        const timeHtml = `<div class="message-time">${escapeHtml(timeText)}</div>`
        const messageBody = `${timeHtml}${senderNameHtml}<div class="message-content">${mediaHtml}${textHtml}</div>`
        const platformMessageId = this.getExportPlatformMessageId(msg)
        const replyToMessageId = this.getExportReplyToMessageId(msg.content)

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
       ${getVirtualScrollScript()}

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
      if (isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      if (isPauseError(e)) {
        return { success: false, error: '导出任务已暂停' }
      }
      return { success: false, error: String(e) }
    }
  }
}
