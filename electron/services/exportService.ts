import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { fileURLToPath } from 'url'
import ExcelJS from 'exceljs'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { imageDecryptService } from './imageDecryptService'
import { chatService } from './chatService'

// ChatLab 格式类型定义
interface ChatLabHeader {
  version: string
  exportedAt: number
  generator: string
  description?: string
}

interface ChatLabMeta {
  name: string
  platform: string
  type: 'group' | 'private'
  groupId?: string
  groupAvatar?: string
}

interface ChatLabMember {
  platformId: string
  accountName: string
  groupNickname?: string
  avatar?: string
}

interface ChatLabMessage {
  sender: string
  accountName: string
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
}

interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// 消息类型映射：微信 localType -> ChatLab type
const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportEmojis?: boolean
  exportVoiceAsText?: boolean
  excelCompactColumns?: boolean
  sessionLayout?: 'shared' | 'per-session'
}

interface MediaExportItem {
  relativePath: string
  kind: 'image' | 'voice' | 'emoji'
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  phase: 'preparing' | 'exporting' | 'writing' | 'complete'
}

class ExportService {
  private configService: ConfigService
  private contactCache: Map<string, { displayName: string; avatarUrl?: string }> = new Map()

  constructor() {
    this.configService = new ConfigService()
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]
    return trimmed
  }

  private async ensureConnected(): Promise<{ success: boolean; cleanedWxid?: string; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '请先在设置页面配置微信ID' }
    if (!dbPath) return { success: false, error: '请先在设置页面配置数据库路径' }
    if (!decryptKey) return { success: false, error: '请先在设置页面配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true, cleanedWxid }
  }

  private async getContactInfo(username: string): Promise<{ displayName: string; avatarUrl?: string }> {
    if (this.contactCache.has(username)) {
      return this.contactCache.get(username)!
    }

    const [displayNames, avatarUrls] = await Promise.all([
      wcdbService.getDisplayNames([username]),
      wcdbService.getAvatarUrls([username])
    ])

    const displayName = displayNames.success && displayNames.map
      ? (displayNames.map[username] || username)
      : username
    const avatarUrl = avatarUrls.success && avatarUrls.map
      ? avatarUrls.map[username]
      : undefined

    const info = { displayName, avatarUrl }
    this.contactCache.set(username, info)
    return info
  }

  /**
   * 转换微信消息类型到 ChatLab 类型
   */
  private convertMessageType(localType: number, content: string): number {
    if (localType === 49) {
      const typeMatch = /<type>(\d+)<\/type>/i.exec(content)
      if (typeMatch) {
        const subType = parseInt(typeMatch[1])
        switch (subType) {
          case 6: return 4   // 文件 -> FILE
          case 33:
          case 36: return 24 // 小程序 -> SHARE
          case 57: return 25 // 引用回复 -> REPLY
          default: return 7  // 链接 -> LINK
        }
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99
  }

  /**
   * 解码消息内容
   */
  private decodeMessageContent(messageContent: any, compressContent: any): string {
    let content = this.decodeMaybeCompressed(compressContent)
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent)
    }
    return content
  }

  private decodeMaybeCompressed(raw: any): string {
    if (!raw) return ''
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''
      if (this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) return this.decodeBinaryContent(bytes)
      }
      if (this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes)
        } catch {
          return raw
        }
      }
      return raw
    }
    return ''
  }

  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''
    try {
      if (data.length >= 4) {
        const magic = data.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          const fzstd = require('fzstd')
          const decompressed = fzstd.decompress(data)
          return Buffer.from(decompressed).toString('utf-8')
        }
      }
      const decoded = data.toString('utf-8')
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }
      return data.toString('latin1')
    } catch {
      return ''
    }
  }

  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  /**
   * 解析消息内容为可读文本
   * 注意：语音消息在这里返回占位符，实际转文字在导出时异步处理
   */
  private parseMessageContent(content: string, localType: number): string | null {
    if (!content) return null

    switch (localType) {
      case 1:
        return this.stripSenderPrefix(content)
      case 3: return '[图片]'
      case 34: return '[语音消息]'  // 占位符，导出时会替换为转文字结果
      case 42: return '[名片]'
      case 43: return '[视频]'
      case 47: return '[动画表情]'
      case 48: return '[位置]'
      case 49: {
        const title = this.extractXmlValue(content, 'title')
        return title || '[链接]'
      }
      case 50: return this.parseVoipMessage(content)
      case 10000: return this.cleanSystemMessage(content)
      case 266287972401: return this.cleanSystemMessage(content)  // 拍一拍
      default:
        if (content.includes('<type>57</type>')) {
          const title = this.extractXmlValue(content, 'title')
          return title || '[引用消息]'
        }
        return this.stripSenderPrefix(content) || null
    }
  }

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '')
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

  private cleanSystemMessage(content: string): string {
    if (!content) return '[系统消息]'

    // 先尝试提取特定的系统消息内容
    // 1. 提取 sysmsg 中的文本内容
    const sysmsgTextMatch = /<sysmsg[^>]*>([\s\S]*?)<\/sysmsg>/i.exec(content)
    if (sysmsgTextMatch) {
      content = sysmsgTextMatch[1]
    }

    // 2. 提取 revokemsg 撤回消息
    const revokeMatch = /<replacemsg><!\[CDATA\[(.*?)\]\]><\/replacemsg>/i.exec(content)
    if (revokeMatch) {
      return revokeMatch[1].trim()
    }

    // 3. 提取 pat 拍一拍消息
    const patMatch = /<template><!\[CDATA\[(.*?)\]\]><\/template>/i.exec(content)
    if (patMatch) {
      // 移除模板变量占位符
      return patMatch[1]
        .replace(/\$\{([^}]+)\}/g, (_, varName) => {
          const varMatch = new RegExp(`<${varName}><!\\\[CDATA\\\[([^\]]*)\\\]\\\]><\/${varName}>`, 'i').exec(content)
          return varMatch ? varMatch[1] : ''
        })
        .replace(/<[^>]+>/g, '')
        .trim()
    }

    // 4. 处理 CDATA 内容
    content = content.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')

    // 5. 移除所有 XML 标签
    return content
      .replace(/<img[^>]*>/gi, '')
      .replace(/<\/?[a-zA-Z0-9_:]+[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim() || '[系统消息]'
  }

  /**
   * 解析通话消息
   * 格式: <voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[...]]></msg><room_type>0/1</room_type>...</VoIPBubbleMsg></voipmsg>
   * room_type: 0 = 语音通话, 1 = 视频通话
   */
  private parseVoipMessage(content: string): string {
    try {
      if (!content) return '[通话]'

      // 提取 msg 内容（中文通话状态）
      const msgMatch = /<msg><!\[CDATA\[(.*?)\]\]><\/msg>/i.exec(content)
      const msg = msgMatch?.[1]?.trim() || ''

      // 提取 room_type（0=视频，1=语音）
      const roomTypeMatch = /<room_type>(\d+)<\/room_type>/i.exec(content)
      const roomType = roomTypeMatch ? parseInt(roomTypeMatch[1], 10) : -1

      // 构建通话类型标签
      let callType: string
      if (roomType === 0) {
        callType = '视频通话'
      } else if (roomType === 1) {
        callType = '语音通话'
      } else {
        callType = '通话'
      }

      // 解析通话状态
      if (msg.includes('通话时长')) {
        const durationMatch = /通话时长\s*(\d{1,2}:\d{2}(?::\d{2})?)/i.exec(msg)
        const duration = durationMatch?.[1] || ''
        if (duration) {
          return `[${callType}] ${duration}`
        }
        return `[${callType}] 已接听`
      } else if (msg.includes('对方无应答')) {
        return `[${callType}] 对方无应答`
      } else if (msg.includes('已取消')) {
        return `[${callType}] 已取消`
      } else if (msg.includes('已在其它设备接听') || msg.includes('已在其他设备接听')) {
        return `[${callType}] 已在其他设备接听`
      } else if (msg.includes('对方已拒绝') || msg.includes('已拒绝')) {
        return `[${callType}] 对方已拒绝`
      } else if (msg.includes('忙线未接听') || msg.includes('忙线')) {
        return `[${callType}] 忙线未接听`
      } else if (msg.includes('未接听')) {
        return `[${callType}] 未接听`
      } else if (msg) {
        return `[${callType}] ${msg}`
      }

      return `[${callType}]`
    } catch (e) {
      return '[通话]'
    }
  }

  /**
   * 获取消息类型名称
   */
  private getMessageTypeName(localType: number): string {
    const typeNames: Record<number, string> = {
      1: '文本消息',
      3: '图片消息',
      34: '语音消息',
      42: '名片消息',
      43: '视频消息',
      47: '动画表情',
      48: '位置消息',
      49: '链接消息',
      50: '通话消息',
      10000: '系统消息'
    }
    return typeNames[localType] || '其他消息'
  }

  /**
   * 格式化时间戳为可读字符串
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  /**
   * 导出媒体文件到指定目录
   */
  private async exportMediaForMessage(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string,
    options: { exportImages?: boolean; exportVoices?: boolean; exportEmojis?: boolean; exportVoiceAsText?: boolean }
  ): Promise<MediaExportItem | null> {
    const localType = msg.localType

    // 图片消息
    if (localType === 3 && options.exportImages) {
      const result = await this.exportImage(msg, sessionId, mediaRootDir, mediaRelativePrefix)
      if (result) {
        }
      return result
    }

    // 语音消息
    if (localType === 34) {
      // 如果开启了语音转文字，优先转文字（不导出语音文件）
      if (options.exportVoiceAsText) {
        return null  // 转文字逻辑在消息内容处理中完成
      }
      // 否则导出语音文件
      if (options.exportVoices) {
        return this.exportVoice(msg, sessionId, mediaRootDir, mediaRelativePrefix)
      }
    }

    // 动画表情
    if (localType === 47 && options.exportEmojis) {
      const result = await this.exportEmoji(msg, sessionId, mediaRootDir, mediaRelativePrefix)
      if (result) {
        }
      return result
    }

    return null
  }

  /**
   * 导出图片文件
   */
  private async exportImage(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string
  ): Promise<MediaExportItem | null> {
    try {
      const imagesDir = path.join(mediaRootDir, mediaRelativePrefix, 'images')
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true })
      }

      // 使用消息对象中已提取的字段
      const imageMd5 = msg.imageMd5
      const imageDatName = msg.imageDatName

      if (!imageMd5 && !imageDatName) {
        return null
      }

      const result = await imageDecryptService.decryptImage({
        sessionId,
        imageMd5,
        imageDatName,
        force: false  // 先尝试缩略图
      })

      if (!result.success || !result.localPath) {
        // 尝试获取缩略图
        const thumbResult = await imageDecryptService.resolveCachedImage({
          sessionId,
          imageMd5,
          imageDatName
        })
        if (!thumbResult.success || !thumbResult.localPath) {
          return null
        }
        result.localPath = thumbResult.localPath
      }

      // 从 data URL 或 file URL 获取实际路径
      let sourcePath = result.localPath
      if (sourcePath.startsWith('data:')) {
        // 是 data URL，需要保存为文件
        const base64Data = sourcePath.split(',')[1]
        const ext = this.getExtFromDataUrl(sourcePath)
        const fileName = `${imageMd5 || imageDatName || msg.localId}${ext}`
        const destPath = path.join(imagesDir, fileName)

        fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'))

        return {
          relativePath: path.posix.join(mediaRelativePrefix, 'images', fileName),
          kind: 'image'
        }
      } else if (sourcePath.startsWith('file://')) {
        sourcePath = fileURLToPath(sourcePath)
      }

      // 复制文件
      if (fs.existsSync(sourcePath)) {
        const ext = path.extname(sourcePath) || '.jpg'
        const fileName = `${imageMd5 || imageDatName || msg.localId}${ext}`
        const destPath = path.join(imagesDir, fileName)

        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(sourcePath, destPath)
        }

        return {
          relativePath: path.posix.join(mediaRelativePrefix, 'images', fileName),
          kind: 'image'
        }
      }

      return null
    } catch (e) {
      return null
    }
  }

  /**
   * 导出语音文件
   */
  private async exportVoice(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string
  ): Promise<MediaExportItem | null> {
    try {
      const voicesDir = path.join(mediaRootDir, mediaRelativePrefix, 'voices')
      if (!fs.existsSync(voicesDir)) {
        fs.mkdirSync(voicesDir, { recursive: true })
      }

      const msgId = String(msg.localId)
      const fileName = `voice_${msgId}.wav`
      const destPath = path.join(voicesDir, fileName)

      // 如果已存在则跳过
      if (fs.existsSync(destPath)) {
        return {
          relativePath: path.posix.join(mediaRelativePrefix, 'voices', fileName),
          kind: 'voice'
        }
      }

      // 调用 chatService 获取语音数据
      const voiceResult = await chatService.getVoiceData(sessionId, msgId)
      if (!voiceResult.success || !voiceResult.data) {
        return null
      }

      // voiceResult.data 是 base64 编码的 wav 数据
      const wavBuffer = Buffer.from(voiceResult.data, 'base64')
      fs.writeFileSync(destPath, wavBuffer)

      return {
        relativePath: path.posix.join(mediaRelativePrefix, 'voices', fileName),
        kind: 'voice'
      }
    } catch (e) {
      return null
    }
  }

  /**
   * 转写语音为文字
   */
  private async transcribeVoice(sessionId: string, msgId: string): Promise<string> {
    try {
      const transcript = await chatService.getVoiceTranscript(sessionId, msgId)
      if (transcript.success && transcript.transcript) {
        return `[语音转文字] ${transcript.transcript}`
      }
      return '[语音消息 - 转文字失败]'
    } catch (e) {
      return '[语音消息 - 转文字失败]'
    }
  }

  /**
   * 导出表情文件
   */
  private async exportEmoji(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string
  ): Promise<MediaExportItem | null> {
    try {
      const emojisDir = path.join(mediaRootDir, mediaRelativePrefix, 'emojis')
      if (!fs.existsSync(emojisDir)) {
        fs.mkdirSync(emojisDir, { recursive: true })
      }

      // 使用消息对象中已提取的字段
      const emojiUrl = msg.emojiCdnUrl
      const emojiMd5 = msg.emojiMd5

      if (!emojiUrl && !emojiMd5) {
        console.log('[ExportService] 表情消息缺少 url 和 md5, localId:', msg.localId, 'content:', msg.content?.substring(0, 200))
        return null
      }

      console.log('[ExportService] 导出表情:', { localId: msg.localId, emojiMd5, emojiUrl: emojiUrl?.substring(0, 100) })

      const key = emojiMd5 || String(msg.localId)
      // 根据 URL 判断扩展名
      let ext = '.gif'
      if (emojiUrl) {
        if (emojiUrl.includes('.png')) ext = '.png'
        else if (emojiUrl.includes('.jpg') || emojiUrl.includes('.jpeg')) ext = '.jpg'
      }
      const fileName = `${key}${ext}`
      const destPath = path.join(emojisDir, fileName)

      // 如果已存在则跳过
      if (fs.existsSync(destPath)) {
        return {
          relativePath: path.posix.join(mediaRelativePrefix, 'emojis', fileName),
          kind: 'emoji'
        }
      }

      // 下载表情
      if (emojiUrl) {
        const downloaded = await this.downloadFile(emojiUrl, destPath)
          if (downloaded) {
            return {
              relativePath: path.posix.join(mediaRelativePrefix, 'emojis', fileName),
              kind: 'emoji'
            }
          } else {
            }
      }

      return null
    } catch (e) {
      return null
    }
  }

  /**
   * 从消息内容提取图片 MD5
   */
  private extractImageMd5(content: string): string | undefined {
    if (!content) return undefined
    const match = /md5="([^"]+)"/i.exec(content)
    return match?.[1]
  }

  /**
   * 从消息内容提取图片 DAT 文件名
   */
  private extractImageDatName(content: string): string | undefined {
    if (!content) return undefined
    // 尝试从 cdnthumburl 或其他字段提取
    const urlMatch = /cdnthumburl[^>]*>([^<]+)/i.exec(content)
    if (urlMatch) {
      const urlParts = urlMatch[1].split('/')
      const last = urlParts[urlParts.length - 1]
      if (last && last.includes('_')) {
        return last.split('_')[0]
      }
    }
    return undefined
  }

  /**
   * 从消息内容提取表情 URL
   */
  private extractEmojiUrl(content: string): string | undefined {
    if (!content) return undefined
    // 参考 echotrace 的正则：cdnurl\s*=\s*['"]([^'"]+)['"] 
    const attrMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
    if (attrMatch) {
      // 解码 &amp; 等实体
      let url = attrMatch[1].replace(/&amp;/g, '&')
      // URL 解码
      try {
        if (url.includes('%')) {
          url = decodeURIComponent(url)
        }
      } catch { }
      return url
    }
    // 备用：尝试 XML 标签形式
    const tagMatch = /cdnurl[^>]*>([^<]+)/i.exec(content)
    return tagMatch?.[1]
  }

  /**
   * 从消息内容提取表情 MD5
   */
  private extractEmojiMd5(content: string): string | undefined {
    if (!content) return undefined
    const match = /md5="([^"]+)"/i.exec(content) || /<md5>([^<]+)<\/md5>/i.exec(content)
    return match?.[1]
  }

  /**
   * 从 data URL 获取扩展名
   */
  private getExtFromDataUrl(dataUrl: string): string {
    if (dataUrl.includes('image/png')) return '.png'
    if (dataUrl.includes('image/gif')) return '.gif'
    if (dataUrl.includes('image/webp')) return '.webp'
    return '.jpg'
  }

  private getMediaLayout(outputPath: string, options: ExportOptions): {
    exportMediaEnabled: boolean
    mediaRootDir: string
    mediaRelativePrefix: string
  } {
    const exportMediaEnabled = options.exportMedia === true &&
      Boolean(options.exportImages || options.exportVoices || options.exportEmojis)
    const outputDir = path.dirname(outputPath)
    const outputBaseName = path.basename(outputPath, path.extname(outputPath))
    const useSharedMediaLayout = options.sessionLayout === 'shared'
    const mediaRelativePrefix = useSharedMediaLayout
      ? path.posix.join('media', outputBaseName)
      : 'media'
    return { exportMediaEnabled, mediaRootDir: outputDir, mediaRelativePrefix }
  }

  /**
   * 下载文件
   */
  private async downloadFile(url: string, destPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const protocol = url.startsWith('https') ? https : http
        const request = protocol.get(url, { timeout: 30000 }, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location
            if (redirectUrl) {
              this.downloadFile(redirectUrl, destPath).then(resolve)
              return
            }
          }
          if (response.statusCode !== 200) {
            resolve(false)
            return
          }
          const fileStream = fs.createWriteStream(destPath)
          response.pipe(fileStream)
          fileStream.on('finish', () => {
            fileStream.close()
            resolve(true)
          })
          fileStream.on('error', () => {
            resolve(false)
          })
        })
        request.on('error', () => resolve(false))
        request.on('timeout', () => {
          request.destroy()
          resolve(false)
        })
      } catch {
        resolve(false)
      }
    })
  }

  private async collectMessages(
    sessionId: string,
    cleanedMyWxid: string,
    dateRange?: { start: number; end: number } | null
  ): Promise<{ rows: any[]; memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>; firstTime: number | null; lastTime: number | null }> {
    const rows: any[] = []
    const memberSet = new Map<string, { member: ChatLabMember; avatarUrl?: string }>()
    let firstTime: number | null = null
    let lastTime: number | null = null

    const cursor = await wcdbService.openMessageCursor(
      sessionId,
      500,
      true,
      dateRange?.start || 0,
      dateRange?.end || 0
    )
    if (!cursor.success || !cursor.cursor) {
      return { rows, memberSet, firstTime, lastTime }
    }

    try {
      let hasMore = true
      while (hasMore) {
        const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
        if (!batch.success || !batch.rows) break
        for (const row of batch.rows) {
          const createTime = parseInt(row.create_time || '0', 10)
          if (dateRange) {
            if (createTime < dateRange.start || createTime > dateRange.end) continue
          }

          const content = this.decodeMessageContent(row.message_content, row.compress_content)
          const localType = parseInt(row.local_type || row.type || '1', 10)
          const senderUsername = row.sender_username || ''
          const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
          const isSend = parseInt(isSendRaw, 10) === 1
          const localId = parseInt(row.local_id || row.localId || '0', 10)

          const actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
          const memberInfo = await this.getContactInfo(actualSender)
          if (!memberSet.has(actualSender)) {
            memberSet.set(actualSender, {
              member: {
                platformId: actualSender,
                accountName: memberInfo.displayName
              },
              avatarUrl: memberInfo.avatarUrl
            })
          }

          // 提取媒体相关字段
          let imageMd5: string | undefined
          let imageDatName: string | undefined
          let emojiCdnUrl: string | undefined
          let emojiMd5: string | undefined

          if (localType === 3 && content) {
            // 图片消息
            imageMd5 = this.extractImageMd5(content)
            imageDatName = this.extractImageDatName(content)
            } else if (localType === 47 && content) {
            // 动画表情
            emojiCdnUrl = this.extractEmojiUrl(content)
            emojiMd5 = this.extractEmojiMd5(content)
            }

          rows.push({
            localId,
            createTime,
            localType,
            content,
            senderUsername: actualSender,
            isSend,
            imageMd5,
            imageDatName,
            emojiCdnUrl,
            emojiMd5
          })

          if (firstTime === null || createTime < firstTime) firstTime = createTime
          if (lastTime === null || createTime > lastTime) lastTime = createTime
        }
        hasMore = batch.hasMore === true
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor.cursor)
    }

    return { rows, memberSet, firstTime, lastTime }
  }

  // 补齐群成员，避免只导出发言者导致头像缺失
  private async mergeGroupMembers(
    chatroomId: string,
    memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>,
    includeAvatars: boolean
  ): Promise<void> {
    const result = await wcdbService.getGroupMembers(chatroomId)
    if (!result.success || !result.members || result.members.length === 0) return

    const rawMembers = result.members as Array<{
      username?: string
      avatarUrl?: string
      nickname?: string
      displayName?: string
      remark?: string
      originalName?: string
    }>
    const usernames = rawMembers
      .map((member) => member.username)
      .filter((username): username is string => Boolean(username))
    if (usernames.length === 0) return

    const lookupUsernames = new Set<string>()
    for (const username of usernames) {
      lookupUsernames.add(username)
      const cleaned = this.cleanAccountDirName(username)
      if (cleaned && cleaned !== username) {
        lookupUsernames.add(cleaned)
      }
    }

    const [displayNames, avatarUrls] = await Promise.all([
      wcdbService.getDisplayNames(Array.from(lookupUsernames)),
      includeAvatars ? wcdbService.getAvatarUrls(Array.from(lookupUsernames)) : Promise.resolve({ success: true, map: {} as Record<string, string> })
    ])

    for (const member of rawMembers) {
      const username = member.username
      if (!username) continue

      const cleaned = this.cleanAccountDirName(username)
      const displayName = displayNames.success && displayNames.map
        ? (displayNames.map[username] || (cleaned ? displayNames.map[cleaned] : undefined) || username)
        : username
      const groupNickname = member.nickname || member.displayName || member.remark || member.originalName
      const avatarUrl = includeAvatars && avatarUrls.success && avatarUrls.map
        ? (avatarUrls.map[username] || (cleaned ? avatarUrls.map[cleaned] : undefined) || member.avatarUrl)
        : member.avatarUrl

      const existing = memberSet.get(username)
      if (existing) {
        if (displayName && existing.member.accountName === existing.member.platformId && displayName !== existing.member.platformId) {
          existing.member.accountName = displayName
        }
        if (groupNickname && !existing.member.groupNickname) {
          existing.member.groupNickname = groupNickname
        }
        if (!existing.avatarUrl && avatarUrl) {
          existing.avatarUrl = avatarUrl
        }
        memberSet.set(username, existing)
        continue
      }

      const chatlabMember: ChatLabMember = {
        platformId: username,
        accountName: displayName
      }
      if (groupNickname) {
        chatlabMember.groupNickname = groupNickname
      }
      memberSet.set(username, { member: chatlabMember, avatarUrl })
    }
  }

  private resolveAvatarFile(avatarUrl?: string): { data?: Buffer; sourcePath?: string; sourceUrl?: string; ext: string; mime?: string } | null {
    if (!avatarUrl) return null
    if (avatarUrl.startsWith('data:')) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(avatarUrl)
      if (!match) return null
      const mime = match[1].toLowerCase()
      const data = Buffer.from(match[2], 'base64')
      const ext = mime.includes('png') ? '.png'
        : mime.includes('gif') ? '.gif'
          : mime.includes('webp') ? '.webp'
            : '.jpg'
      return { data, ext, mime }
    }
    if (avatarUrl.startsWith('file://')) {
      try {
        const sourcePath = fileURLToPath(avatarUrl)
        const ext = path.extname(sourcePath) || '.jpg'
        return { sourcePath, ext }
      } catch {
        return null
      }
    }
    if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
      const url = new URL(avatarUrl)
      const ext = path.extname(url.pathname) || '.jpg'
      return { sourceUrl: avatarUrl, ext }
    }
    const sourcePath = avatarUrl
    const ext = path.extname(sourcePath) || '.jpg'
    return { sourcePath, ext }
  }

  private async downloadToBuffer(url: string, remainingRedirects = 2): Promise<{ data: Buffer; mime?: string } | null> {
    const client = url.startsWith('https:') ? https : http
    return new Promise((resolve) => {
      const request = client.get(url, (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location && remainingRedirects > 0) {
          res.resume()
          const redirectedUrl = new URL(res.headers.location, url).href
          this.downloadToBuffer(redirectedUrl, remainingRedirects - 1)
            .then(resolve)
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          resolve(null)
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const data = Buffer.concat(chunks)
          const mime = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined
          resolve({ data, mime })
        })
      })
      request.on('error', () => resolve(null))
      request.setTimeout(15000, () => {
        request.destroy()
        resolve(null)
      })
    })
  }

  private async exportAvatars(
    members: Array<{ username: string; avatarUrl?: string }>
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (members.length === 0) return result

    for (const member of members) {
      const fileInfo = this.resolveAvatarFile(member.avatarUrl)
      if (!fileInfo) continue
      try {
        let data: Buffer | null = null
        let mime = fileInfo.mime
        if (fileInfo.data) {
          data = fileInfo.data
        } else if (fileInfo.sourcePath && fs.existsSync(fileInfo.sourcePath)) {
          data = await fs.promises.readFile(fileInfo.sourcePath)
        } else if (fileInfo.sourceUrl) {
          const downloaded = await this.downloadToBuffer(fileInfo.sourceUrl)
          if (downloaded) {
            data = downloaded.data
            mime = downloaded.mime || mime
          }
        }
        if (!data) continue

        // 优先使用内容检测出的 MIME 类型
        const detectedMime = this.detectMimeType(data)
        const finalMime = detectedMime || mime || this.inferImageMime(fileInfo.ext)

        const base64 = data.toString('base64')
        result.set(member.username, `data:${finalMime};base64,${base64}`)
      } catch {
        continue
      }
    }

    return result
  }

  private detectMimeType(buffer: Buffer): string | null {
    if (buffer.length < 4) return null

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png'
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg'
    }

    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif'
    }

    // WEBP: RIFF ... WEBP
    if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp'
    }

    // BMP: 42 4D
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
      return 'image/bmp'
    }

    return null
  }

  private inferImageMime(ext: string): string {
    switch (ext.toLowerCase()) {
      case '.png':
        return 'image/png'
      case '.gif':
        return 'image/gif'
      case '.webp':
        return 'image/webp'
      case '.bmp':
        return 'image/bmp'
      default:
        return 'image/jpeg'
    }
  }

  /**
   * 生成通用的导出元数据 (参考 ChatLab 格式)
   */
  private getExportMeta(
    sessionId: string,
    sessionInfo: { displayName: string },
    isGroup: boolean,
    sessionAvatar?: string
  ): { chatlab: ChatLabHeader; meta: ChatLabMeta } {
    return {
      chatlab: {
        version: '0.0.2',
        exportedAt: Math.floor(Date.now() / 1000),
        generator: 'WeFlow'
      },
      meta: {
        name: sessionInfo.displayName,
        platform: 'wechat',
        type: isGroup ? 'group' : 'private',
        ...(isGroup && { groupId: sessionId }),
        ...(sessionAvatar && { groupAvatar: sessionAvatar })
      }
    }
  }

  /**
   * 导出单个会话为 ChatLab 格式
   */
  async exportSessionToChatLab(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')

      const sessionInfo = await this.getContactInfo(sessionId)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)
      const allMessages = collected.rows
      if (isGroup) {
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }

      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 50,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

        const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
        const mediaCache = new Map<string, MediaExportItem | null>()
        const chatLabMessages: ChatLabMessage[] = []
        for (const msg of allMessages) {
          const memberInfo = collected.memberSet.get(msg.senderUsername)?.member || {
            platformId: msg.senderUsername,
            accountName: msg.senderUsername,
            groupNickname: undefined
          }

          let content = this.parseMessageContent(msg.content, msg.localType)
          if (exportMediaEnabled) {
            const mediaKey = `${msg.localType}_${msg.localId}`
            if (!mediaCache.has(mediaKey)) {
              const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
                exportImages: options.exportImages,
                exportVoices: options.exportVoices,
                exportEmojis: options.exportEmojis,
                exportVoiceAsText: options.exportVoiceAsText
              })
              mediaCache.set(mediaKey, mediaItem)
            }
          }
          if (msg.localType === 34 && options.exportVoiceAsText) {
            // 如果是语音消息且开启了转文字
            content = await this.transcribeVoice(sessionId, String(msg.localId))
          }

          chatLabMessages.push({
            sender: msg.senderUsername,
            accountName: memberInfo.accountName,
            groupNickname: memberInfo.groupNickname,
            timestamp: msg.createTime,
            type: this.convertMessageType(msg.localType, msg.content),
            content: content
          })
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
      const members = Array.from(collected.memberSet.values()).map((info) => {
        const avatar = avatarMap.get(info.member.platformId)
        return avatar ? { ...info.member, avatar } : info.member
      })

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
        phase: 'writing'
      })

      if (options.format === 'chatlab-jsonl') {
        const lines: string[] = []
        lines.push(JSON.stringify({
          _type: 'header',
          chatlab: chatLabExport.chatlab,
          meta: chatLabExport.meta
        }))
        for (const member of chatLabExport.members) {
          lines.push(JSON.stringify({ _type: 'member', ...member }))
        }
        for (const message of chatLabExport.messages) {
          lines.push(JSON.stringify({ _type: 'message', ...message }))
        }
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
      } else {
        fs.writeFileSync(outputPath, JSON.stringify(chatLabExport, null, 2), 'utf-8')
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为详细 JSON 格式（原项目格式）
   */
  async exportSessionToDetailedJson(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')

      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

        const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)
        const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
        const mediaCache = new Map<string, MediaExportItem | null>()
        const allMessages: any[] = []

        for (const msg of collected.rows) {
          const senderInfo = await this.getContactInfo(msg.senderUsername)
          const sourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(msg.content || '')
          const source = sourceMatch ? sourceMatch[0] : ''

          let content = this.parseMessageContent(msg.content, msg.localType)
          let mediaItem: MediaExportItem | null = null
          if (exportMediaEnabled) {
            const mediaKey = `${msg.localType}_${msg.localId}`
            if (mediaCache.has(mediaKey)) {
              mediaItem = mediaCache.get(mediaKey) || null
            } else {
              mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
                exportImages: options.exportImages,
                exportVoices: options.exportVoices,
                exportEmojis: options.exportEmojis,
                exportVoiceAsText: options.exportVoiceAsText
              })
              mediaCache.set(mediaKey, mediaItem)
            }
          }
          if (mediaItem) {
            content = mediaItem.relativePath
          } else if (msg.localType === 34 && options.exportVoiceAsText) {
            content = await this.transcribeVoice(sessionId, String(msg.localId))
          }

          allMessages.push({
            localId: allMessages.length + 1,
            createTime: msg.createTime,
          formattedTime: this.formatTimestamp(msg.createTime),
          type: this.getMessageTypeName(msg.localType),
          localType: msg.localType,
          content,
          isSend: msg.isSend ? 1 : 0,
          senderUsername: msg.senderUsername,
          senderDisplayName: senderInfo.displayName,
          source,
          senderAvatarKey: msg.senderUsername
        })
      }

      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      const { chatlab, meta } = this.getExportMeta(sessionId, sessionInfo, isGroup)

      const detailedExport: any = {
        chatlab,
        meta,
        session: {
          wxid: sessionId,
          nickname: sessionInfo.displayName,
          remark: sessionInfo.displayName,
          displayName: sessionInfo.displayName,
          type: isGroup ? '群聊' : '私聊',
          lastTimestamp: collected.lastTime,
          messageCount: allMessages.length,
          avatar: undefined as string | undefined
        },
        messages: allMessages
      }

      if (options.exportAvatars) {
        const avatarMap = await this.exportAvatars(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl }
          ]
        )
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

      fs.writeFileSync(outputPath, JSON.stringify(detailedExport, null, 2), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 Excel 格式（参考 echotrace 格式）
   */
  async exportSessionToExcel(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')

      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      // 获取会话的备注信息
      const sessionContact = await wcdbService.getContact(sessionId)
      const sessionRemark = sessionContact.success && sessionContact.contact?.remark ? sessionContact.contact.remark : ''
      const sessionNickname = sessionContact.success && sessionContact.contact?.nickName ? sessionContact.contact.nickName : sessionId

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)

      onProgress?.({
        current: 30,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
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
      const headers = useCompactColumns
        ? ['序号', '时间', '发送者身份', '消息类型', '内容']
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
        worksheet.getColumn(6).width = 15  // 发送者身份
        worksheet.getColumn(7).width = 12  // 消息类型
        worksheet.getColumn(8).width = 50  // 内容
      }

      // 填充数据
      const sortedMessages = collected.rows.sort((a, b) => a.createTime - b.createTime)

      // 媒体导出设置
      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // 媒体导出缓存
      const mediaCache = new Map<string, MediaExportItem | null>()

      for (let i = 0; i < sortedMessages.length; i++) {
        const msg = sortedMessages[i]

        // 导出媒体文件
        let mediaItem: MediaExportItem | null = null
        if (exportMediaEnabled) {
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (mediaCache.has(mediaKey)) {
            mediaItem = mediaCache.get(mediaKey) || null
          } else {
            mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
        }

        // 确定发送者信息
        let senderRole: string
        let senderWxid: string
        let senderNickname: string
        let senderRemark: string = ''

        if (msg.isSend) {
          // 我发送的消息
          senderRole = '我'
          senderWxid = cleanedMyWxid
          senderNickname = myInfo.displayName || cleanedMyWxid
          senderRemark = ''
        } else if (isGroup && msg.senderUsername) {
          // 群消息
          senderWxid = msg.senderUsername

          // 用 getContact 获取联系人详情，分别取昵称和备注
          const contactDetail = await wcdbService.getContact(msg.senderUsername)
          if (contactDetail.success && contactDetail.contact) {
            // nickName 才是真正的昵称
            senderNickname = contactDetail.contact.nickName || msg.senderUsername
            senderRemark = contactDetail.contact.remark || ''
            // 身份：有备注显示备注，没有显示昵称
            senderRole = senderRemark || senderNickname
          } else {
            senderNickname = msg.senderUsername
            senderRemark = ''
            senderRole = msg.senderUsername
          }
        } else {
          // 单聊对方消息 - 用 getContact 获取联系人详情
          senderWxid = sessionId
          const contactDetail = await wcdbService.getContact(sessionId)
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

        // 确定内容：如果有媒体文件导出成功则显示相对路径，否则显示解析后的内容
        let contentValue = mediaItem
          ? mediaItem.relativePath
          : (this.parseMessageContent(msg.content, msg.localType) || '')
        if (!mediaItem && msg.localType === 34 && options.exportVoiceAsText) {
          contentValue = await this.transcribeVoice(sessionId, String(msg.localId))
        }

        // 调试日志
        if (msg.localType === 3 || msg.localType === 47) {
          }

        worksheet.getCell(currentRow, 1).value = i + 1
        worksheet.getCell(currentRow, 2).value = this.formatTimestamp(msg.createTime)
        if (useCompactColumns) {
          worksheet.getCell(currentRow, 3).value = senderRole
          worksheet.getCell(currentRow, 4).value = this.getMessageTypeName(msg.localType)
          worksheet.getCell(currentRow, 5).value = contentValue
        } else {
          worksheet.getCell(currentRow, 3).value = senderNickname
          worksheet.getCell(currentRow, 4).value = senderWxid
          worksheet.getCell(currentRow, 5).value = senderRemark
          worksheet.getCell(currentRow, 6).value = senderRole
          worksheet.getCell(currentRow, 7).value = this.getMessageTypeName(msg.localType)
          worksheet.getCell(currentRow, 8).value = contentValue
        }

        // 设置每个单元格的样式
        const maxColumns = useCompactColumns ? 5 : 8
        for (let col = 1; col <= maxColumns; col++) {
          const cell = worksheet.getCell(currentRow, col)
          cell.font = { name: 'Calibri', size: 11 }
          cell.alignment = { vertical: 'middle', wrapText: false }
        }

        currentRow++

        // 每处理 100 条消息报告一次进度
        if ((i + 1) % 100 === 0) {
          const progress = 30 + Math.floor((i + 1) / sortedMessages.length * 50)
          onProgress?.({
            current: progress,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting'
          })
        }
      }

      onProgress?.({
        current: 90,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      // 写入文件
      await workbook.xlsx.writeFile(outputPath)

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      // 处理文件被占用的错误
      if (e instanceof Error) {
        if (e.message.includes('EBUSY') || e.message.includes('resource busy') || e.message.includes('locked')) {
          return { success: false, error: '文件已经打开，请关闭后再导出' }
        }
      }

      return { success: false, error: String(e) }
    }
  }

  /**
   * 批量导出多个会话
   */
  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount: number; failCount: number; error?: string }> {
    let successCount = 0
    let failCount = 0

    try {
      const conn = await this.ensureConnected()
      if (!conn.success) {
        return { success: false, successCount: 0, failCount: sessionIds.length, error: conn.error }
      }

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

        const exportMediaEnabled = options.exportMedia === true &&
          Boolean(options.exportImages || options.exportVoices || options.exportEmojis)
        const sessionLayout = exportMediaEnabled
          ? (options.sessionLayout ?? 'per-session')
          : 'shared'

        for (let i = 0; i < sessionIds.length; i++) {
          const sessionId = sessionIds[i]
          const sessionInfo = await this.getContactInfo(sessionId)

        onProgress?.({
          current: i + 1,
          total: sessionIds.length,
          currentSession: sessionInfo.displayName,
          phase: 'exporting'
        })

          const safeName = sessionInfo.displayName.replace(/[<>:"/\\|?*]/g, '_')
          const useSessionFolder = sessionLayout === 'per-session'
          const sessionDir = useSessionFolder ? path.join(outputDir, safeName) : outputDir

          if (useSessionFolder && !fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true })
          }

        let ext = '.json'
        if (options.format === 'chatlab-jsonl') ext = '.jsonl'
        else if (options.format === 'excel') ext = '.xlsx'
        const outputPath = path.join(sessionDir, `${safeName}${ext}`)

        let result: { success: boolean; error?: string }
        if (options.format === 'json') {
          result = await this.exportSessionToDetailedJson(sessionId, outputPath, options)
        } else if (options.format === 'chatlab' || options.format === 'chatlab-jsonl') {
          result = await this.exportSessionToChatLab(sessionId, outputPath, options)
        } else if (options.format === 'excel') {
          result = await this.exportSessionToExcel(sessionId, outputPath, options)
        } else {
          result = { success: false, error: `不支持的格式: ${options.format}` }
        }

        if (result.success) {
          successCount++
        } else {
          failCount++
          console.error(`导出 ${sessionId} 失败:`, result.error)
        }
      }

      onProgress?.({
        current: sessionIds.length,
        total: sessionIds.length,
        currentSession: '',
        phase: 'complete'
      })

      return { success: true, successCount, failCount }
    } catch (e) {
      return { success: false, successCount, failCount, error: String(e) }
    }
  }
}

export const exportService = new ExportService()
