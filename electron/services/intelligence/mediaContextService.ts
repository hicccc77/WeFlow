/**
 * Media Context Service — routes WCDB messages to appropriate media processors
 *
 * Exports:
 * - MediaContextService class: main media processing service
 * - mediaContextService: singleton instance
 *
 * Handles 7 media types:
 * 1. Image (type 3): decrypt -> resize -> base64 -> Vision LLM describe
 * 2. Voice (type 34): detect placeholder -> transcribe
 * 3. Video (type 43): ffmpeg extract audio + keyframes -> Vision describe
 * 4. Article (type 49, gh_): fetch body -> LLM summarize
 * 5. Video Channel (type 49, xmlType 51): metadata only
 * 6. Forward (type 49, xmlType 19): flatten chat records
 * 7. Mini-program (type 49, xmlType 33/36): metadata only
 */

import { MediaContext, WCDBMessage, ChatRecordItem } from './types'
import { llmService } from './llmService'

// Lazy imports for Node.js built-ins
let _fs: typeof import('fs') | null = null
let _path: typeof import('path') | null = null
let _childProcess: typeof import('child_process') | null = null

function getFs() {
  if (!_fs) _fs = require('fs')
  return _fs!
}
function getPath() {
  if (!_path) _path = require('path')
  return _path!
}
function getChildProcess() {
  if (!_childProcess) _childProcess = require('child_process')
  return _childProcess!
}

// Lazy imports for heavy dependencies
let _sharp: any = null
let _ffmpegPath: string | null = null

function getSharp() {
  if (!_sharp) {
    try {
      _sharp = require('sharp')
    } catch {
      _sharp = null
    }
  }
  return _sharp
}

function getFfmpegPath(): string | null {
  if (_ffmpegPath === null) {
    try {
      _ffmpegPath = require('ffmpeg-static') as string
    } catch {
      _ffmpegPath = ''
    }
  }
  return _ffmpegPath || null
}

// ─── SSRF Protection ────────────────────────────────────────────

const ALLOWED_ARTICLE_HOSTS = ['mp.weixin.qq.com']
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function isUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.local')) return false
    // Reject private/loopback IPs
    // Only apply IP regex to actual IP addresses, not hostnames
    const isIpAddress = /^[\d.:[\]]+$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname)
    if (isIpAddress) {
      if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1|fc|fd|fe80)/i.test(hostname)) return false
    }
    return true
  } catch {
    return false
  }
}

function isWeixinArticle(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_ARTICLE_HOSTS.includes(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

// ─── Media Processing Cache ─────────────────────────────────────

interface CacheEntry {
  result: MediaContext
  timestamp: number
}

const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

// ─── HTML Text Extraction ───────────────────────────────────────

function extractArticleText(html: string): string {
  // Remove scripts, styles, nav, footer, sidebar
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // Try to extract article or main content
  const articleMatch = /<article[\s\S]*?>([\s\S]*?)<\/article>/i.exec(text)
  const mainMatch = /<main[\s\S]*?>([\s\S]*?)<\/main>/i.exec(text)
  const richMediaMatch = /<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>/i.exec(text)

  if (richMediaMatch) {
    text = richMediaMatch[1]
  } else if (articleMatch) {
    text = articleMatch[1]
  } else if (mainMatch) {
    text = mainMatch[1]
  }

  // Extract img alt text
  const altTexts: string[] = []
  const imgRegex = /<img[^>]+alt=["']([^"']+)["'][^>]*>/gi
  let imgMatch: RegExpExecArray | null
  while ((imgMatch = imgRegex.exec(text)) !== null) {
    if (imgMatch[1].trim()) {
      altTexts.push(`[图: ${imgMatch[1].trim()}]`)
    }
  }

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ')
  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
  // Clean whitespace
  text = text.replace(/\s+/g, ' ').trim()

  // Insert alt texts
  if (altTexts.length > 0) {
    text = text + '\n\n' + altTexts.join('\n')
  }

  return text
}

function extractGenericPageText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const articleMatch = /<article[\s\S]*?>([\s\S]*?)<\/article>/i.exec(text)
  const mainMatch = /<main[\s\S]*?>([\s\S]*?)<\/main>/i.exec(text)

  if (articleMatch) {
    text = articleMatch[1]
  } else if (mainMatch) {
    text = mainMatch[1]
  }

  text = text.replace(/<[^>]+>/g, ' ')
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

  // Truncate to 3000 chars
  if (text.length > 3000) {
    text = text.slice(0, 3000) + '...'
  }

  return text
}

// ─── XML Value Extraction ───────────────────────────────────────

function extractXmlValue(content: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/${tag}>`, 'i')
  const match = regex.exec(content)
  return match ? match[1].trim() : undefined
}

function parseXmlType(content: string): number | null {
  if (!content) return null
  // Extract from appmsg > type, skipping nested elements
  const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
  if (appmsgMatch) {
    const inner = appmsgMatch[1]
      .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
      .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
    const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(inner)
    if (typeMatch) {
      const val = parseInt(typeMatch[1].trim(), 10)
      return Number.isFinite(val) ? val : null
    }
  }
  const fallback = extractXmlValue(content, 'type')
  if (fallback) {
    const val = parseInt(fallback, 10)
    return Number.isFinite(val) ? val : null
  }
  return null
}

// ─── Service ────────────────────────────────────────────────────

export class MediaContextService {
  private cache = new Map<string, CacheEntry>()

  // External dependencies — injected or stubbed
  private imageDecryptService: any = null
  private voiceTranscribeService: any = null

  setImageDecryptService(service: any): void {
    this.imageDecryptService = service
  }

  setVoiceTranscribeService(service: any): void {
    this.voiceTranscribeService = service
  }

  /**
   * Determine the media type of a WCDB message.
   * Returns null for plain text (type 1) or unsupported types.
   */
  getMediaType(message: WCDBMessage): MediaContext['type'] | null {
    switch (message.localType) {
      case 3:
        return 'image'
      case 34:
        return 'voice'
      case 43:
        return 'video'
      case 49: {
        const rawContent = message.rawContent || message.parsedContent || ''
        const xmlType = message.xmlType ? parseInt(message.xmlType, 10) : parseXmlType(rawContent)
        if (xmlType === 5 || xmlType === 49) {
          // Check for gh_ prefix (official account)
          const sourceUsername = extractXmlValue(rawContent, 'sourceusername') || ''
          if (sourceUsername.startsWith('gh_')) return 'article'
          // Also check for URL presence — it's a link/article
          const url = extractXmlValue(rawContent, 'url')
          if (url) return 'article'
          return null
        }
        if (xmlType === 51) return 'video-channel'
        if (xmlType === 19) return 'forward'
        if (xmlType === 33 || xmlType === 36) return 'miniapp'
        return null
      }
      default:
        return null
    }
  }

  /**
   * Route a WCDB message to the appropriate media processor.
   * Returns null for plain text messages.
   */
  async processMessage(message: WCDBMessage): Promise<MediaContext | null> {
    const mediaType = this.getMediaType(message)
    if (!mediaType) return null

    // Check cache
    const cacheKey = `${message.localId}-${mediaType}`
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.result
    }

    let result: MediaContext

    try {
      switch (mediaType) {
        case 'image':
          result = await this.processImage(message.localId, message.imageMd5)
          break
        case 'voice':
          result = await this.processVoice(message)
          break
        case 'video':
          result = await this.processVideo(message)
          break
        case 'article':
          result = await this.processArticleFromMessage(message)
          break
        case 'video-channel':
          result = this.processVideoChannel(message)
          break
        case 'forward':
          result = await this.processForwardFromMessage(message)
          break
        case 'miniapp':
          result = this.processMiniApp(message)
          break
        default:
          return null
      }
    } catch (error) {
      // Return graceful fallback on error
      result = this.buildErrorFallback(mediaType, message, error)
    }

    // Store in cache
    this.cache.set(cacheKey, { result, timestamp: Date.now() })
    return result
  }

  /**
   * Image: decrypt -> resize -> base64 -> Vision LLM describe
   */
  async processImage(localId: number, md5?: string): Promise<MediaContext> {
    const originalContent = `[image:${localId}]`

    // Step 1: Decrypt
    let buffer: Buffer | null = null
    let ext = 'jpeg'

    if (this.imageDecryptService) {
      try {
        const result = await this.imageDecryptService.decryptImage({
          localId,
          imageMd5: md5,
        })
        if (result.success && result.localPath) {
          const fs = getFs()
          if (fs.existsSync(result.localPath)) {
            const stat = fs.statSync(result.localPath)
            if (stat.size > MAX_FILE_SIZE) {
              return {
                type: 'image',
                originalContent,
                processedContent: '[图片] (文件过大，跳过处理)',
                metadata: { localId, error: 'file_too_large' },
              }
            }
            buffer = fs.readFileSync(result.localPath)
            const extMatch = result.localPath.match(/\.(\w+)$/)
            if (extMatch) ext = extMatch[1].toLowerCase()
          }
        }
      } catch {
        return {
          type: 'image',
          originalContent,
          processedContent: '[图片] (无法解密)',
          metadata: { localId, error: 'decrypt_failed' },
        }
      }
    }

    if (!buffer) {
      return {
        type: 'image',
        originalContent,
        processedContent: '[图片] (无法解密)',
        metadata: { localId, error: 'no_buffer' },
      }
    }

    // Step 2: Resize if > 5MB (0.7x steps)
    const sharp = getSharp()
    if (sharp) {
      try {
        let current = buffer
        let attempts = 0
        while (current.length > 5 * 1024 * 1024 && attempts < 5) {
          const metadata = await sharp(current).metadata()
          const newWidth = Math.floor((metadata.width || 1024) * 0.7)
          current = await sharp(current)
            .resize(newWidth, null, { withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer()
          ext = 'jpeg'
          attempts++
        }
        buffer = current
      } catch {
        // Use original buffer if resize fails
      }
    }

    // Step 3: Base64 encode
    const base64Data = buffer.toString('base64')
    const mediaType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'

    // Step 4: Vision LLM describe
    let description = '(无法分析)'
    try {
      description = await llmService.describeImage(base64Data, mediaType)
    } catch {
      // Fallback: no description
    }

    return {
      type: 'image',
      originalContent,
      processedContent: `[图片] ${description}`,
      base64Data,
      mediaType,
      metadata: { localId, md5, ext },
    }
  }

  /**
   * Voice: detect "发了一条语音" placeholder -> transcribe
   */
  async processVoice(message: WCDBMessage): Promise<MediaContext> {
    const originalContent = message.parsedContent || message.rawContent || ''
    const isVoicePlaceholder = originalContent.includes('发了一条语音')

    if (!isVoicePlaceholder && message.localType !== 34) {
      return {
        type: 'voice',
        originalContent,
        processedContent: originalContent,
      }
    }

    if (!this.voiceTranscribeService) {
      return {
        type: 'voice',
        originalContent,
        processedContent: '[语音] (转写服务不可用)',
        metadata: { localId: message.localId, error: 'service_unavailable' },
      }
    }

    try {
      // Try cached transcription first, then fall back to live transcription
      const result = await this.voiceTranscribeService.transcribeWavBuffer?.(message.localId) ||
                     await this.voiceTranscribeService.transcribe?.(message.localId)

      if (result?.text) {
        return {
          type: 'voice',
          originalContent,
          processedContent: `[语音转文字] ${result.text}`,
          metadata: { localId: message.localId, duration: result.duration },
        }
      }

      return {
        type: 'voice',
        originalContent,
        processedContent: '[语音] (文件缺失)',
        metadata: { localId: message.localId, error: 'transcription_empty' },
      }
    } catch {
      return {
        type: 'voice',
        originalContent,
        processedContent: '[语音] (文件缺失)',
        metadata: { localId: message.localId, error: 'transcription_failed' },
      }
    }
  }

  /**
   * Video: ffmpeg extract audio -> transcribe + 4 keyframes -> Vision describe
   */
  async processVideo(message: WCDBMessage): Promise<MediaContext> {
    const originalContent = message.parsedContent || message.rawContent || '[视频]'
    const ffmpegPath = getFfmpegPath()

    if (!ffmpegPath) {
      return {
        type: 'video',
        originalContent,
        processedContent: '视频内容描述：(ffmpeg不可用)',
        metadata: { localId: message.localId, error: 'ffmpeg_unavailable' },
      }
    }

    // TODO: Resolve actual video file path from WCDB message
    // For now, return a placeholder with metadata
    const videoPath = this.resolveVideoPath(message)

    if (!videoPath) {
      return {
        type: 'video',
        originalContent,
        processedContent: '视频内容描述：(视频文件未找到)',
        metadata: { localId: message.localId, error: 'file_not_found' },
      }
    }

    try {
      const fs = getFs()
      const stat = fs.statSync(videoPath)
      if (stat.size > MAX_FILE_SIZE) {
        return {
          type: 'video',
          originalContent,
          processedContent: '视频内容描述：(文件过大，跳过处理)',
          metadata: { localId: message.localId, error: 'file_too_large' },
        }
      }

      // Extract audio + keyframes in parallel
      const [audioText, frameDescriptions] = await Promise.allSettled([
        this.extractVideoAudio(videoPath, ffmpegPath),
        this.extractKeyframes(videoPath, ffmpegPath),
      ])

      const audio = audioText.status === 'fulfilled' ? audioText.value : ''
      const frames = frameDescriptions.status === 'fulfilled' ? frameDescriptions.value : []

      const parts: string[] = []
      if (audio) parts.push(`语音内容：${audio}`)
      if (frames.length > 0) parts.push(`画面：${frames.join('、')}`)

      return {
        type: 'video',
        originalContent,
        processedContent: `视频内容描述：${parts.join('。') || '(无法解析)'}`,
        metadata: { localId: message.localId, hasAudio: !!audio, frameCount: frames.length },
      }
    } catch {
      return {
        type: 'video',
        originalContent,
        processedContent: '视频内容描述：(处理失败)',
        metadata: { localId: message.localId, error: 'processing_failed' },
      }
    }
  }

  /**
   * Article: fetch body -> LLM summarize <= 1500 chars.
   */
  async processArticle(url: string, title: string, description?: string): Promise<MediaContext> {
    const originalContent = `[链接] ${title}: ${url}`

    if (!isUrlSafe(url)) {
      return {
        type: 'article',
        originalContent,
        processedContent: `[分享] ${title}${description ? ': ' + description : ''}`,
        metadata: { url, error: 'unsafe_url' },
      }
    }

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15000),
      })

      if (!response.ok) {
        return {
          type: 'article',
          originalContent,
          processedContent: `[分享] ${title}${description ? ': ' + description : ''}`,
          metadata: { url, error: `http_${response.status}` },
        }
      }

      const html = await response.text()
      const isWeixin = isWeixinArticle(url)
      const text = isWeixin ? extractArticleText(html) : extractGenericPageText(html)

      if (!text || text.length < 50) {
        return {
          type: 'article',
          originalContent,
          processedContent: `[分享] ${title}${description ? ': ' + description : ''}`,
          metadata: { url, error: 'empty_content' },
        }
      }

      // LLM summarize
      const truncatedText = text.length > 5000 ? text.slice(0, 5000) : text
      try {
        const summary = await llmService.summarize(truncatedText, 1500)
        return {
          type: 'article',
          originalContent,
          processedContent: `[已解析的分享内容] ${summary}`,
          metadata: { url, title, textLength: text.length },
        }
      } catch {
        // LLM failed, use truncated text
        const fallbackText = text.slice(0, 1500)
        return {
          type: 'article',
          originalContent,
          processedContent: `[已解析的分享内容] ${fallbackText}`,
          metadata: { url, title, error: 'llm_failed' },
        }
      }
    } catch (error: any) {
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      return {
        type: 'article',
        originalContent,
        processedContent: isTimeout
          ? `[链接] (加载超时)`
          : `[分享] ${title}${description ? ': ' + description : ''}`,
        metadata: { url, error: isTimeout ? 'timeout' : 'fetch_failed' },
      }
    }
  }

  /**
   * Video Channel: metadata only (cannot download video stream)
   */
  processVideoChannel(message: WCDBMessage): MediaContext {
    const rawContent = message.rawContent || message.parsedContent || ''
    const creator = message.finderNickname || extractXmlValue(rawContent, 'findernickname') || extractXmlValue(rawContent, 'finder_nickname') || '未知'
    const title = message.linkTitle || extractXmlValue(rawContent, 'title') || '未知视频'

    return {
      type: 'video-channel',
      originalContent: rawContent,
      processedContent: `[视频号] ${creator}: ${title}`,
      metadata: {
        creator,
        title,
        coverUrl: message.finderCoverUrl || extractXmlValue(rawContent, 'thumbUrl') || extractXmlValue(rawContent, 'coverUrl'),
        duration: message.finderDuration,
      },
    }
  }

  /**
   * Forward: flatten recursive chat record list
   */
  async processForward(chatRecordList: ChatRecordItem[]): Promise<MediaContext> {
    const lines = this.flattenChatRecords(chatRecordList)
    const text = lines.join('\n')

    return {
      type: 'forward',
      originalContent: JSON.stringify(chatRecordList).slice(0, 500),
      processedContent: `[转发]\n${text}`,
      metadata: { recordCount: lines.length },
    }
  }

  /**
   * Mini-program: metadata only
   */
  processMiniApp(message: WCDBMessage): MediaContext {
    const rawContent = message.rawContent || message.parsedContent || ''
    const appName = message.appMsgAppName || extractXmlValue(rawContent, 'appname') || extractXmlValue(rawContent, 'sourcedisplayname') || '未知小程序'
    const title = message.linkTitle || extractXmlValue(rawContent, 'title') || ''

    return {
      type: 'miniapp',
      originalContent: rawContent,
      processedContent: `[小程序] ${appName}: ${title}`,
      metadata: {
        appName,
        title,
        url: message.linkUrl || extractXmlValue(rawContent, 'url'),
      },
    }
  }

  /**
   * Evict expired cache entries
   */
  evictExpiredCache(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > CACHE_TTL_MS) {
        this.cache.delete(key)
      }
    }
  }

  // ─── Internal Helpers ───────────────────────────────────────

  private async processArticleFromMessage(message: WCDBMessage): Promise<MediaContext> {
    const rawContent = message.rawContent || message.parsedContent || ''
    const url = message.linkUrl || extractXmlValue(rawContent, 'url') || ''
    const title = message.linkTitle || extractXmlValue(rawContent, 'title') || '未知链接'
    const description = message.appMsgDesc || extractXmlValue(rawContent, 'des') || undefined

    if (!url) {
      return {
        type: 'article',
        originalContent: rawContent,
        processedContent: `[分享] ${title}${description ? ': ' + description : ''}`,
        metadata: { error: 'no_url' },
      }
    }

    return this.processArticle(url, title, description)
  }

  private async processForwardFromMessage(message: WCDBMessage): Promise<MediaContext> {
    const chatRecordList = message.chatRecordList
    if (chatRecordList && chatRecordList.length > 0) {
      return this.processForward(chatRecordList)
    }

    // Try parsing from raw content
    const rawContent = message.rawContent || message.parsedContent || ''
    const title = message.chatRecordTitle || extractXmlValue(rawContent, 'title') || '聊天记录'

    return {
      type: 'forward',
      originalContent: rawContent,
      processedContent: `[转发] ${title}`,
      metadata: { error: 'no_records' },
    }
  }

  private flattenChatRecords(records: ChatRecordItem[], depth: number = 0): string[] {
    const lines: string[] = []
    const indent = '  '.repeat(depth)

    for (const record of records) {
      const sender = record.sourcename || '未知'
      const content = record.datadesc || record.datatitle || '(无内容)'

      lines.push(`${indent}${sender}: ${content}`)

      // Recurse into nested chat records
      if (record.chatRecordList && record.chatRecordList.length > 0) {
        lines.push(`${indent}[嵌套转发]`)
        lines.push(...this.flattenChatRecords(record.chatRecordList, depth + 1))
      }
    }

    return lines
  }

  private resolveVideoPath(message: WCDBMessage): string | null {
    const fs = getFs()
    const path = getPath()

    // Extract video md5 from message XML content
    const content = message.rawContent || message.parsedContent || ''
    const md5Match = content.match(/<md5>([a-f0-9]+)<\/md5>/i)
      || content.match(/md5[=:]\s*"?([a-f0-9]+)"?/i)
    if (!md5Match) return null

    const videoMd5 = md5Match[1].toLowerCase()

    // Get db path and wxid from config (lazy import)
    try {
      const { ConfigService } = require('../config')
      const config = ConfigService.getInstance()
      const dbPath = config.get('dbPath') || ''
      const wxid = config.get('myWxid') || ''
      if (!dbPath || !wxid) return null

      // WeChat video path: {dbPath}/{wxid}/msg/video/{yearMonth}/{md5}.mp4
      const cleanedWxid = wxid.match(/^(wxid_[^_]+)/i)?.[1] || wxid
      const videoBaseDir = path.join(dbPath, cleanedWxid, 'msg', 'video')
      if (!fs.existsSync(videoBaseDir)) return null

      // Scan year-month directories for the video file
      const yearMonthDirs = fs.readdirSync(videoBaseDir)
        .filter((dir: string) => {
          try { return fs.statSync(path.join(videoBaseDir, dir)).isDirectory() }
          catch { return false }
        })
        .sort((a: string, b: string) => b.localeCompare(a))

      for (const ym of yearMonthDirs) {
        const videoPath = path.join(videoBaseDir, ym, `${videoMd5}.mp4`)
        if (fs.existsSync(videoPath)) return videoPath
        // Also check _raw variant
        const rawPath = path.join(videoBaseDir, ym, `${videoMd5}_raw.mp4`)
        if (fs.existsSync(rawPath)) return rawPath
      }
    } catch {
      // Config not available or directory scan failed
    }
    return null
  }

  private async extractVideoAudio(videoPath: string, ffmpegPath: string): Promise<string> {
    const fs = getFs()
    const path = getPath()
    const cp = getChildProcess()
    const os = require('os')

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-video-'))

    const audioPath = path.join(tempDir, 'audio.wav')

    return new Promise((resolve, reject) => {
      const proc = cp.spawn(ffmpegPath, [
        '-i', videoPath,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        '-y',
        audioPath,
      ], { timeout: 30000 })

      proc.on('close', async (code: number | null) => {
        if (code !== 0 || !fs.existsSync(audioPath)) {
          resolve('')
          return
        }

        try {
          if (this.voiceTranscribeService) {
            const wavBuffer = fs.readFileSync(audioPath)
            const result = await this.voiceTranscribeService.transcribeWavBuffer?.(wavBuffer)
            resolve(result?.text || '')
          } else {
            resolve('')
          }
        } catch {
          resolve('')
        } finally {
          // Cleanup temp file
          try { fs.unlinkSync(audioPath) } catch { /* ignore */ }
        }
      })

      proc.on('error', () => resolve(''))
    })
  }

  private async extractKeyframes(videoPath: string, ffmpegPath: string): Promise<string[]> {
    const fs = getFs()
    const path = getPath()
    const cp = getChildProcess()
    const os = require('os')

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-frames-'))

    const framePrefix = path.join(tempDir, 'frame_')

    return new Promise((resolve) => {
      const proc = cp.spawn(ffmpegPath, [
        '-i', videoPath,
        '-vf', 'fps=0.2',
        '-frames:v', '4',
        '-q:v', '5',
        '-y',
        `${framePrefix}%d.jpg`,
      ], { timeout: 30000 })

      proc.on('close', async () => {
        const descriptions: string[] = []

        for (let i = 1; i <= 4; i++) {
          const framePath = `${framePrefix}${i}.jpg`
          if (!fs.existsSync(framePath)) continue

          try {
            const buffer = fs.readFileSync(framePath)
            const base64 = buffer.toString('base64')
            const desc = await llmService.describeImage(base64, 'image/jpeg', '用2句话以内描述这个视频帧的内容')
            descriptions.push(desc)
          } catch {
            descriptions.push('(帧描述失败)')
          } finally {
            try { fs.unlinkSync(framePath) } catch { /* ignore */ }
          }
        }

        resolve(descriptions)
      })

      proc.on('error', () => resolve([]))
    })
  }

  private buildErrorFallback(type: MediaContext['type'], message: WCDBMessage, error: unknown): MediaContext {
    const errorMsg = error instanceof Error ? error.message : String(error)
    const fallbackMap: Record<string, string> = {
      'image': '[图片] (无法解密)',
      'voice': '[语音] (文件缺失)',
      'video': '视频内容描述：(处理失败)',
      'article': '[链接] (加载超时)',
      'video-channel': '[视频号] (解析失败)',
      'forward': '[转发] (解析失败)',
      'miniapp': '[小程序] (解析失败)',
    }

    return {
      type,
      originalContent: message.rawContent || message.parsedContent || '',
      processedContent: fallbackMap[type] || `[${type}] (处理失败)`,
      metadata: { error: errorMsg, localId: message.localId },
    }
  }
}

// Exported helper for testing
export { extractArticleText, extractGenericPageText, parseXmlType, isUrlSafe, extractXmlValue }

export const mediaContextService = new MediaContextService()
