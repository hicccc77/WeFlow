import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { fileURLToPath } from 'url'
import ExcelJS from 'exceljs'
import { getEmojiPath } from 'wechat-emojis'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { imageDecryptService } from './imageDecryptService'
import { chatService } from './chatService'
import { videoService } from './videoService'
import { voiceTranscribeService } from './voiceTranscribeService'
import { EXPORT_HTML_STYLES } from './exportHtmlStyles'

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
  chatRecords?: any[]  // 嵌套的聊天记录
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
  exportVideos?: boolean
  exportEmojis?: boolean
  exportVoiceAsText?: boolean
  excelCompactColumns?: boolean
  txtColumns?: string[]
  sessionLayout?: 'shared' | 'per-session'
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
}

const TXT_COLUMN_DEFINITIONS: Array<{ id: string; label: string }> = [
  { id: 'index', label: '序号' },
  { id: 'time', label: '时间' },
  { id: 'senderRole', label: '发送者身份' },
  { id: 'messageType', label: '消息类型' },
  { id: 'content', label: '内容' },
  { id: 'senderNickname', label: '发送者昵称' },
  { id: 'senderWxid', label: '发送者微信ID' },
  { id: 'senderRemark', label: '发送者备注' }
]

interface MediaExportItem {
  relativePath: string
  kind: 'image' | 'voice' | 'emoji' | 'video'
  posterDataUrl?: string
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  phase: 'preparing' | 'exporting' | 'exporting-media' | 'exporting-voice' | 'writing' | 'complete'
}

// 并发控制：限制同时执行的 Promise 数量
async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0

  async function runNext(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++
      results[index] = await fn(items[index], index)
    }
  }

  // 启动 limit 个并发任务
  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(() => runNext())

  await Promise.all(workers)
  return results
}

class ExportService {
  private configService: ConfigService
  private contactCache: Map<string, { displayName: string; avatarUrl?: string }> = new Map()
  private inlineEmojiCache: Map<string, string> = new Map()
  private htmlStyleCache: string | null = null

  constructor() {
    this.configService = new ConfigService()
  }

  private getClampedConcurrency(value: number | undefined, fallback = 2, max = 6): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    const raw = Math.floor(value)
    return Math.max(1, Math.min(raw, max))
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
    const cleaned = suffixMatch ? suffixMatch[1] : trimmed

    return cleaned
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

    const [nameResult, avatarResult] = await Promise.all([
      wcdbService.getDisplayNames([username]),
      wcdbService.getAvatarUrls([username])
    ])

    const displayName = (nameResult.success && nameResult.map ? nameResult.map[username] : null) || username
    const avatarUrl = avatarResult.success && avatarResult.map ? avatarResult.map[username] : undefined

    const info = { displayName, avatarUrl }
    this.contactCache.set(username, info)
    return info
  }

  private async preloadContacts(
    usernames: Iterable<string>,
    cache: Map<string, { success: boolean; contact?: any; error?: string }>,
    limit = 8
  ): Promise<void> {
    const unique = Array.from(new Set(Array.from(usernames).filter(Boolean)))
    if (unique.length === 0) return
    await parallelLimit(unique, limit, async (username) => {
      if (cache.has(username)) return
      const result = await wcdbService.getContact(username)
      cache.set(username, result)
    })
  }

  /**
   * 从 DLL 获取群成员的群昵称
   */
  async getGroupNicknamesForRoom(chatroomId: string): Promise<Map<string, string>> {
    try {
      const result = await wcdbService.getGroupNicknames(chatroomId)
      if (result.success && result.nicknames) {
        return new Map(Object.entries(result.nicknames))
      }
      return new Map<string, string>()
    } catch (e) {
      console.error('getGroupNicknamesForRoom error:', e)
      return new Map<string, string>()
    }
  }

  /**
   * 转换微信消息类型到 ChatLab 类型
   */
  private convertMessageType(localType: number, content: string): number {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? parseInt(xmlTypeMatch[1]) : null
    
    // 特殊处理 type 49 或 XML type
    if (localType === 49 || xmlType) {
      const subType = xmlType || 0
      switch (subType) {
        case 6: return 4   // 文件 -> FILE
        case 19: return 7  // 聊天记录 -> LINK (ChatLab 没有专门的聊天记录类型)
        case 33:
        case 36: return 24 // 小程序 -> SHARE
        case 57: return 25 // 引用回复 -> REPLY
        case 2000: return 99 // 转账 -> OTHER (ChatLab 没有转账类型)
        case 5:
        case 49: return 7  // 链接 -> LINK
        default: 
          if (xmlType) return 7 // 有 XML type 但未知，默认为链接
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99 // 未知类型 -> OTHER
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
      if (/^[0-9]+$/.test(raw)) {
        return raw
      }
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      if (raw.length > 16 && this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) return this.decodeBinaryContent(bytes)
      }
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (raw.length > 16 && this.looksLikeBase64(raw)) {
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

  private normalizeGroupNickname(value: string): string {
    const trimmed = (value || '').trim()
    if (!trimmed) return ''
    const cleaned = trimmed.replace(/[\x00-\x1F\x7F]/g, '')
    if (!cleaned) return ''
    if (/^[,"'“”‘’，、]+$/.test(cleaned)) return ''
    return cleaned
  }

  /**
   * 根据用户偏好获取显示名称
   */
  private getPreferredDisplayName(
    wxid: string,
    nickname: string,
    remark: string,
    groupNickname: string,
    preference: 'group-nickname' | 'remark' | 'nickname' = 'remark'
  ): string {
    switch (preference) {
      case 'group-nickname':
        return groupNickname || remark || nickname || wxid
      case 'remark':
        return remark || nickname || wxid
      case 'nickname':
        return nickname || wxid
      default:
        return nickname || wxid
    }
  }

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  /**
   * 解析消息内容为可读文本
   * 注意：语音消息在这里返回占位符，实际转文字在导出时异步处理
   */
  private parseMessageContent(content: string, localType: number, sessionId?: string, createTime?: number): string | null {
    if (!content) return null

    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null

    switch (localType) {
      case 1: // 文本
        return this.stripSenderPrefix(content)
      case 3: return '[图片]'
      case 34: {
        // 语音消息 - 尝试获取转写文字
        if (sessionId && createTime) {
          const transcript = voiceTranscribeService.getCachedTranscript(sessionId, createTime)
          if (transcript) {
            return `[语音消息] ${transcript}`
          }
        }
        return '[语音消息]'  // 占位符，导出时会替换为转文字结果
      }
      case 42: return '[名片]'
      case 43: return '[视频]'
      case 47: return '[动画表情]'
      case 48: return '[位置]'
      case 49: {
        const title = this.extractXmlValue(content, 'title')
        const type = this.extractXmlValue(content, 'type')
        
        // 转账消息特殊处理
        if (type === '2000') {
          const feedesc = this.extractXmlValue(content, 'feedesc')
          const payMemo = this.extractXmlValue(content, 'pay_memo')
          if (feedesc) {
            return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
          }
          return '[转账]'
        }
        
        if (type === '6') return title ? `[文件] ${title}` : '[文件]'
        if (type === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]'
        if (type === '33' || type === '36') return title ? `[小程序] ${title}` : '[小程序]'
        if (type === '57') return title || '[引用消息]'
        if (type === '5' || type === '49') return title ? `[链接] ${title}` : '[链接]'
        return title ? `[链接] ${title}` : '[链接]'
      }
      case 50: return this.parseVoipMessage(content)
      case 10000: return this.cleanSystemMessage(content)
      case 266287972401: return this.cleanSystemMessage(content)  // 拍一拍
      case 244813135921: {
        // 引用消息
        const title = this.extractXmlValue(content, 'title')
        return title || '[引用消息]'
      }
      default:
        // 对于未知的 localType，检查 XML type 来判断消息类型
        if (xmlType) {
          const title = this.extractXmlValue(content, 'title')
          
          // 群公告消息（type 87）
          if (xmlType === '87') {
            const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
            if (textAnnouncement) {
              return `[群公告] ${textAnnouncement}`
            }
            return '[群公告]'
          }
          
          // 转账消息
          if (xmlType === '2000') {
            const feedesc = this.extractXmlValue(content, 'feedesc')
            const payMemo = this.extractXmlValue(content, 'pay_memo')
            if (feedesc) {
              return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
            }
            return '[转账]'
          }
          
          // 其他类型
          if (xmlType === '6') return title ? `[文件] ${title}` : '[文件]'
          if (xmlType === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]'
          if (xmlType === '33' || xmlType === '36') return title ? `[小程序] ${title}` : '[小程序]'
          if (xmlType === '57') return title || '[引用消息]'
          if (xmlType === '5' || xmlType === '49') return title ? `[链接] ${title}` : '[链接]'
          
          // 有 title 就返回 title
          if (title) return title
        }
        
        // 最后尝试提取文本内容
        return this.stripSenderPrefix(content) || null
    }
  }

  private formatPlainExportContent(
    content: string,
    localType: number,
    options: { exportVoiceAsText?: boolean },
    voiceTranscript?: string
  ): string {
    const safeContent = content || ''

    if (localType === 3) return '[图片]'
    if (localType === 1) return this.stripSenderPrefix(safeContent)
    if (localType === 34) {
      if (options.exportVoiceAsText) {
        return voiceTranscript || '[语音消息 - 转文字失败]'
      }
      return '[其他消息]'
    }
    if (localType === 42) {
      const normalized = this.normalizeAppMessageContent(safeContent)
      const nickname =
        this.extractXmlValue(normalized, 'nickname') ||
        this.extractXmlValue(normalized, 'displayname') ||
        this.extractXmlValue(normalized, 'name')
      return nickname ? `[名片]${nickname}` : '[名片]'
    }
    if (localType === 43) {
      const normalized = this.normalizeAppMessageContent(safeContent)
      const lengthValue =
        this.extractXmlValue(normalized, 'playlength') ||
        this.extractXmlValue(normalized, 'playLength') ||
        this.extractXmlValue(normalized, 'length') ||
        this.extractXmlValue(normalized, 'duration')
      const seconds = lengthValue ? this.parseDurationSeconds(lengthValue) : null
      return seconds ? `[视频]${seconds}s` : '[视频]'
    }
    if (localType === 48) {
      const normalized = this.normalizeAppMessageContent(safeContent)
      const location =
        this.extractXmlValue(normalized, 'label') ||
        this.extractXmlValue(normalized, 'poiname') ||
        this.extractXmlValue(normalized, 'poiName') ||
        this.extractXmlValue(normalized, 'name')
      return location ? `[定位]${location}` : '[定位]'
    }
    if (localType === 50) {
      return this.parseVoipMessage(safeContent)
    }
    if (localType === 10000 || localType === 266287972401) {
      return this.cleanSystemMessage(safeContent)
    }

    const normalized = this.normalizeAppMessageContent(safeContent)
    const isAppMessage = normalized.includes('<appmsg') || normalized.includes('<msg>')
    if (localType === 49 || isAppMessage) {
      const typeMatch = /<type>(\d+)<\/type>/i.exec(normalized)
      const subType = typeMatch ? parseInt(typeMatch[1], 10) : 0
      const title = this.extractXmlValue(normalized, 'title') || this.extractXmlValue(normalized, 'appname')
      
      // 群公告消息（type 87）
      if (subType === 87) {
        const textAnnouncement = this.extractXmlValue(normalized, 'textannouncement')
        if (textAnnouncement) {
          return `[群公告]${textAnnouncement}`
        }
        return '[群公告]'
      }
      
      // 转账消息特殊处理
      if (subType === 2000 || title.includes('转账') || normalized.includes('transfer')) {
        const feedesc = this.extractXmlValue(normalized, 'feedesc')
        const payMemo = this.extractXmlValue(normalized, 'pay_memo')
        if (feedesc) {
          return payMemo ? `[转账]${feedesc} ${payMemo}` : `[转账]${feedesc}`
        }
        const amount = this.extractAmountFromText(
          [
            title,
            this.extractXmlValue(normalized, 'des'),
            this.extractXmlValue(normalized, 'money'),
            this.extractXmlValue(normalized, 'amount'),
            this.extractXmlValue(normalized, 'fee')
          ]
            .filter(Boolean)
            .join(' ')
        )
        return amount ? `[转账]${amount}` : '[转账]'
      }
      
      if (subType === 3 || normalized.includes('<musicurl') || normalized.includes('<songname')) {
        const songName = this.extractXmlValue(normalized, 'songname') || title || '音乐'
        return `[音乐]${songName}`
      }
      if (subType === 6) {
        const fileName = this.extractXmlValue(normalized, 'filename') || title || '文件'
        return `[文件]${fileName}`
      }
      if (title.includes('红包') || normalized.includes('hongbao')) {
        return `[红包]${title || '微信红包'}`
      }
      if (subType === 19 || normalized.includes('<recorditem')) {
        const forwardName =
          this.extractXmlValue(normalized, 'nickname') ||
          this.extractXmlValue(normalized, 'title') ||
          this.extractXmlValue(normalized, 'des') ||
          this.extractXmlValue(normalized, 'displayname')
        return forwardName ? `[转发的聊天记录]${forwardName}` : '[转发的聊天记录]'
      }
      if (subType === 33 || subType === 36) {
        const appName = this.extractXmlValue(normalized, 'appname') || title || '小程序'
        return `[小程序]${appName}`
      }
      if (subType === 57) {
        return title || '[引用消息]'
      }
      if (title) {
        return `[链接]${title}`
      }
      return '[其他消息]'
    }

    return '[其他消息]'
  }

  private parseDurationSeconds(value: string): number | null {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    if (numeric >= 1000) return Math.round(numeric / 1000)
    return Math.round(numeric)
  }

  private extractAmountFromText(text: string): string | null {
    if (!text) return null
    const match = /([¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(text)
    return match ? match[1].replace(/\s+/g, '') : null
  }

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '')
  }

  /**
   * 从撤回消息内容中提取撤回者的 wxid
   * 撤回消息 XML 格式通常包含 <session> 或 <newmsgid> 等字段
   * 以及撤回者的 wxid 在某些字段中
   * @returns { isRevoke: true, isSelfRevoke: true } - 是自己撤回的消息
   * @returns { isRevoke: true, revokerWxid: string } - 是别人撤回的消息，提取到撤回者
   * @returns { isRevoke: false } - 不是撤回消息
   */
  private extractRevokerInfo(content: string): { isRevoke: boolean; isSelfRevoke?: boolean; revokerWxid?: string } {
    if (!content) return { isRevoke: false }
    
    // 检查是否是撤回消息
    if (!content.includes('revokemsg') && !content.includes('撤回')) {
      return { isRevoke: false }
    }
    
    // 检查是否是 "你撤回了" - 自己撤回
    if (content.includes('你撤回')) {
      return { isRevoke: true, isSelfRevoke: true }
    }
    
    // 尝试从 <session> 标签提取（格式: wxid_xxx）
    const sessionMatch = /<session>([^<]+)<\/session>/i.exec(content)
    if (sessionMatch) {
      const session = sessionMatch[1].trim()
      // 如果 session 是 wxid 格式，返回它
      if (session.startsWith('wxid_') || /^[a-zA-Z][a-zA-Z0-9_-]+$/.test(session)) {
        return { isRevoke: true, revokerWxid: session }
      }
    }
    
    // 尝试从 <fromusername> 提取
    const fromUserMatch = /<fromusername>([^<]+)<\/fromusername>/i.exec(content)
    if (fromUserMatch) {
      return { isRevoke: true, revokerWxid: fromUserMatch[1].trim() }
    }
    
    // 是撤回消息但无法提取撤回者
    return { isRevoke: true }
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
  private getMessageTypeName(localType: number, content?: string): string {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    if (content) {
      const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
      const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null
      
      if (xmlType) {
        switch (xmlType) {
          case '87': return '群公告'
          case '2000': return '转账消息'
          case '5': return '链接消息'
          case '6': return '文件消息'
          case '19': return '聊天记录'
          case '33':
          case '36': return '小程序消息'
          case '57': return '引用消息'
        }
      }
    }

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
      10000: '系统消息',
      244813135921: '引用消息'
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

  private normalizeTxtColumns(columns?: string[] | null): string[] {
    const fallback = ['index', 'time', 'senderRole', 'messageType', 'content']
    const selected = new Set((columns && columns.length > 0 ? columns : fallback).filter(Boolean))
    const ordered = TXT_COLUMN_DEFINITIONS.map((col) => col.id).filter((id) => selected.has(id))
    return ordered.length > 0 ? ordered : fallback
  }

  private sanitizeTxtValue(value: string): string {
    return value.replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim()
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  private escapeAttribute(value: string): string {
    return this.escapeHtml(value).replace(/`/g, '&#96;')
  }

  private getAvatarFallback(name: string): string {
    if (!name) return '?'
    return [...name][0] || '?'
  }

  private renderMultilineText(value: string): string {
    return this.escapeHtml(value).replace(/\r?\n/g, '<br />')
  }

  private loadExportHtmlStyles(): string {
    if (this.htmlStyleCache !== null) {
      return this.htmlStyleCache
    }
    const candidates = [
      path.join(__dirname, 'exportHtml.css'),
      path.join(process.cwd(), 'electron', 'services', 'exportHtml.css')
    ]
    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          if (content.trim().length > 0) {
            this.htmlStyleCache = content
            return content
          }
        } catch {
          continue
        }
      }
    }
    this.htmlStyleCache = EXPORT_HTML_STYLES
    return this.htmlStyleCache
  }

  /**
   * 解析合并转发的聊天记录 (Type 19)
   */
  private parseChatHistory(content: string): any[] | undefined {
    try {
      const type = this.extractXmlValue(content, 'type')
      if (type !== '19') return undefined

      // 提取 recorditem 中的 CDATA
      const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
      if (!match) return undefined

      const innerXml = match[1]
      const items: any[] = []
      const itemRegex = /<dataitem\s+(.*?)>([\s\S]*?)<\/dataitem>/g
      let itemMatch

      while ((itemMatch = itemRegex.exec(innerXml)) !== null) {
        const attrs = itemMatch[1]
        const body = itemMatch[2]

        const datatypeMatch = /datatype="(\d+)"/.exec(attrs)
        const datatype = datatypeMatch ? parseInt(datatypeMatch[1]) : 0

        const sourcename = this.extractXmlValue(body, 'sourcename')
        const sourcetime = this.extractXmlValue(body, 'sourcetime')
        const sourceheadurl = this.extractXmlValue(body, 'sourceheadurl')
        const datadesc = this.extractXmlValue(body, 'datadesc')
        const datatitle = this.extractXmlValue(body, 'datatitle')
        const fileext = this.extractXmlValue(body, 'fileext')
        const datasize = parseInt(this.extractXmlValue(body, 'datasize') || '0')

        items.push({
          datatype,
          sourcename,
          sourcetime,
          sourceheadurl,
          datadesc: this.decodeHtmlEntities(datadesc),
          datatitle: this.decodeHtmlEntities(datatitle),
          fileext,
          datasize
        })
      }

      return items.length > 0 ? items : undefined
    } catch (e) {
      console.error('ExportService: 解析聊天记录失败:', e)
      return undefined
    }
  }

  /**
   * 解码 HTML 实体
   */
  private decodeHtmlEntities(text: string): string {
    if (!text) return ''
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
  }

  private normalizeAppMessageContent(content: string): string {
    if (!content) return ''
    if (content.includes('&lt;') && content.includes('&gt;')) {
      return content
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    }
    return content
  }

  private getInlineEmojiDataUrl(name: string): string | null {
    if (!name) return null
    const cached = this.inlineEmojiCache.get(name)
    if (cached) return cached
    const emojiPath = getEmojiPath(name as any)
    if (!emojiPath) return null
    const baseDir = path.dirname(require.resolve('wechat-emojis'))
    const absolutePath = path.join(baseDir, emojiPath)
    if (!fs.existsSync(absolutePath)) return null
    try {
      const buffer = fs.readFileSync(absolutePath)
      const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
      this.inlineEmojiCache.set(name, dataUrl)
      return dataUrl
    } catch {
      return null
    }
  }

  private renderTextWithEmoji(text: string): string {
    if (!text) return ''
    const parts = text.split(/\[(.*?)\]/g)
    const rendered = parts.map((part, index) => {
      if (index % 2 === 1) {
        const emojiDataUrl = this.getInlineEmojiDataUrl(part)
        if (emojiDataUrl) {
          return `<img class="inline-emoji" src="${this.escapeAttribute(emojiDataUrl)}" alt="[${this.escapeAttribute(part)}]" />`
        }
        return this.escapeHtml(`[${part}]`)
      }
      return this.escapeHtml(part)
    })
    return rendered.join('')
  }

  private formatHtmlMessageText(content: string, localType: number): string {
    if (!content) return ''

    if (localType === 1) {
      return this.stripSenderPrefix(content)
    }

    if (localType === 34) {
      return this.parseMessageContent(content, localType) || ''
    }

    return this.formatPlainExportContent(content, localType, { exportVoiceAsText: false })
  }

  /**
   * 导出媒体文件到指定目录
   */
  private async exportMediaForMessage(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string,
    options: {
      exportImages?: boolean
      exportVoices?: boolean
      exportVideos?: boolean
      exportEmojis?: boolean
      exportVoiceAsText?: boolean
      includeVoiceWithTranscript?: boolean
    }
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
      if (options.exportVoices) {
        return this.exportVoice(msg, sessionId, mediaRootDir, mediaRelativePrefix)
      }
      if (options.exportVoiceAsText) {
        return null
      }
    }

    // 动画表情
    if (localType === 47 && options.exportEmojis) {
      const result = await this.exportEmoji(msg, sessionId, mediaRootDir, mediaRelativePrefix)
      if (result) {
      }
      return result
    }

    if (localType === 43 && options.exportVideos) {
      return this.exportVideo(msg, sessionId, mediaRootDir, mediaRelativePrefix)
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
  private async transcribeVoice(sessionId: string, msgId: string, createTime: number, senderWxid: string | null): Promise<string> {
    try {
      const transcript = await chatService.getVoiceTranscript(sessionId, msgId, createTime, undefined, senderWxid || undefined)
      if (transcript.success && transcript.transcript) {
        return `[语音转文字] ${transcript.transcript}`
      }
      return `[语音消息 - 转文字失败: ${transcript.error || '未知错误'}]`
    } catch (e) {
      return `[语音消息 - 转文字失败: ${String(e)}]`
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

        return null
      }



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
   * 导出视频文件
   */
  private async exportVideo(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string
  ): Promise<MediaExportItem | null> {
    try {
      const videoMd5 = msg.videoMd5
      if (!videoMd5) return null

      const videosDir = path.join(mediaRootDir, mediaRelativePrefix, 'videos')
      if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true })
      }

      const videoInfo = await videoService.getVideoInfo(videoMd5)
      if (!videoInfo.exists || !videoInfo.videoUrl) {
        return null
      }

      const sourcePath = videoInfo.videoUrl
      const fileName = path.basename(sourcePath)
      const destPath = path.join(videosDir, fileName)

      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(sourcePath, destPath)
      }

      return {
        relativePath: path.posix.join(mediaRelativePrefix, 'videos', fileName),
        kind: 'video',
        posterDataUrl: videoInfo.coverUrl || videoInfo.thumbUrl
      }
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

  private extractVideoMd5(content: string): string | undefined {
    if (!content) return undefined
    const attrMatch = /<videomsg[^>]*\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
    if (attrMatch) {
      return attrMatch[1].toLowerCase()
    }
    const tagMatch = /<md5>([^<]+)<\/md5>/i.exec(content)
    return tagMatch?.[1]?.toLowerCase()
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
      Boolean(options.exportImages || options.exportVoices || options.exportVideos || options.exportEmojis)
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
    const senderSet = new Set<string>()
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

          // 确定实际发送者
          let actualSender: string
          if (localType === 10000 || localType === 266287972401) {
            // 系统消息特殊处理
            const revokeInfo = this.extractRevokerInfo(content)
            if (revokeInfo.isRevoke) {
              // 撤回消息
              if (revokeInfo.isSelfRevoke) {
                // "你撤回了" - 发送者是当前用户
                actualSender = cleanedMyWxid
              } else if (revokeInfo.revokerWxid) {
                // 提取到了撤回者的 wxid
                actualSender = revokeInfo.revokerWxid
              } else {
                // 无法确定撤回者，使用 sessionId
                actualSender = sessionId
              }
            } else {
              // 普通系统消息（如"xxx加入群聊"），发送者是群聊ID
              actualSender = sessionId
            }
          } else {
            actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
          }
          senderSet.add(actualSender)

          // 提取媒体相关字段
          let imageMd5: string | undefined
          let imageDatName: string | undefined
          let emojiCdnUrl: string | undefined
          let emojiMd5: string | undefined
          let videoMd5: string | undefined
          let chatRecordList: any[] | undefined

          if (localType === 3 && content) {
            // 图片消息
            imageMd5 = this.extractImageMd5(content)
            imageDatName = this.extractImageDatName(content)
          } else if (localType === 47 && content) {
            // 动画表情
            emojiCdnUrl = this.extractEmojiUrl(content)
            emojiMd5 = this.extractEmojiMd5(content)
          } else if (localType === 43 && content) {
            // 视频消息
            videoMd5 = this.extractVideoMd5(content)
          } else if (localType === 49 && content) {
            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            if (xmlType === '19') {
              chatRecordList = this.parseChatHistory(content)
            }
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
            emojiMd5,
            videoMd5,
            chatRecordList
          })

          if (firstTime === null || createTime < firstTime) firstTime = createTime
          if (lastTime === null || createTime > lastTime) lastTime = createTime
        }
        hasMore = batch.hasMore === true
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor.cursor)
    }

    if (senderSet.size > 0) {
      const usernames = Array.from(senderSet)
      const [nameResult, avatarResult] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames)
      ])

      const nameMap = nameResult.success && nameResult.map ? nameResult.map : {}
      const avatarMap = avatarResult.success && avatarResult.map ? avatarResult.map : {}

      for (const username of usernames) {
        const displayName = nameMap[username] || username
        const avatarUrl = avatarMap[username]
        memberSet.set(username, {
          member: {
            platformId: username,
            accountName: displayName
          },
          avatarUrl
        })
        this.contactCache.set(username, { displayName, avatarUrl })
      }
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

    // 直接使用 URL，不转换为 base64（与 ciphertalk 保持一致）
    for (const member of members) {
      if (member.avatarUrl) {
        result.set(member.username, member.avatarUrl)
      }
    }

    return result
  }

  /**
   * 导出头像为外部文件（仅用于HTML格式）
   * 将头像保存到 avatars/ 子目录，返回相对路径
   */
  private async exportAvatarsToFiles(
    members: Array<{ username: string; avatarUrl?: string }>,
    outputDir: string
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (members.length === 0) return result

    // 创建 avatars 子目录
    const avatarsDir = path.join(outputDir, 'avatars')
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true })
    }

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

        // 根据 MIME 类型确定文件扩展名
        const ext = this.getExtensionFromMime(finalMime)

        // 清理用户名作为文件名（移除非法字符，限制长度）
        const sanitizedUsername = member.username
          .replace(/[<>:"/\\|?*@]/g, '_')
          .substring(0, 100)

        const filename = `${sanitizedUsername}${ext}`
        const avatarPath = path.join(avatarsDir, filename)

        // 保存头像文件
        await fs.promises.writeFile(avatarPath, data)

        // 返回相对路径
        result.set(member.username, `avatars/${filename}`)
      } catch {
        continue
      }
    }

    return result
  }

  private getExtensionFromMime(mime: string): string {
    switch (mime) {
      case 'image/png':
        return '.png'
      case 'image/gif':
        return '.gif'
      case 'image/webp':
        return '.webp'
      case 'image/bmp':
        return '.bmp'
      case 'image/jpeg':
      default:
        return '.jpg'
    }
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

  private getWeflowHeader(): { version: string; exportedAt: number; generator: string } {
    return {
      version: '1.0.3',
      exportedAt: Math.floor(Date.now() / 1000),
      generator: 'WeFlow'
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
   * 导出单个会话为 ChatLab 格式（并行优化版本）
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

      // 如果没有消息,不创建文件
      if (allMessages.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? allMessages.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      if (isGroup) {
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }

      // ========== 获取群昵称并更新到 memberSet ==========
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId)
        : new Map<string, string>()

      // 将群昵称更新到 memberSet 中
      if (isGroup && groupNicknamesMap.size > 0) {
        for (const [username, info] of collected.memberSet) {
          // 尝试多种方式查找群昵称（支持大小写）
          const groupNickname = groupNicknamesMap.get(username) 
            || groupNicknamesMap.get(username.toLowerCase())
            || ''
          if (groupNickname) {
            info.member.groupNickname = groupNickname
          }
        }
      }

      allMessages.sort((a, b) => a.createTime - b.createTime)

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 阶段1：并行导出媒体文件 ==========
      const mediaMessages = exportMediaEnabled
        ? allMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||   // 图片
            (t === 47 && options.exportEmojis) ||  // 表情
            (t === 43 && options.exportVideos) ||  // 视频
            (t === 34 && options.exportVoices)  // 语音文件
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 20,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media'
        })

        // 并行导出媒体，并发数跟随导出设置
        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
        })
      }

      // ========== 阶段2：并行语音转文字 ==========
      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 40,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice'
        })

        // 并行转写语音，限制 4 个并发（转写比较耗资源）
        const VOICE_CONCURRENCY = 4
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
        })
      }

      // ========== 阶段3：构建消息列表 ==========
      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const chatLabMessages: ChatLabMessage[] = allMessages.map(msg => {
        const memberInfo = collected.memberSet.get(msg.senderUsername)?.member || {
          platformId: msg.senderUsername,
          accountName: msg.senderUsername,
          groupNickname: undefined
        }

        // 如果 memberInfo 中没有群昵称，尝试从 groupNicknamesMap 获取
        const groupNickname = memberInfo.groupNickname 
          || (isGroup ? (groupNicknamesMap.get(msg.senderUsername) || groupNicknamesMap.get(msg.senderUsername?.toLowerCase()) || '') : '')
          || ''

        // 确定消息内容
        let content: string | null
        if (msg.localType === 34 && options.exportVoiceAsText) {
          // 使用预先转写的文字
          content = voiceTranscriptMap.get(msg.localId) || '[语音消息 - 转文字失败]'
        } else {
          content = this.parseMessageContent(msg.content, msg.localType, sessionId, msg.createTime)
        }

        const message: ChatLabMessage = {
          sender: msg.senderUsername,
          accountName: memberInfo.accountName,
          groupNickname: groupNickname || undefined,
          timestamp: msg.createTime,
          type: this.convertMessageType(msg.localType, msg.content),
          content: content
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
                recordContent = '[动画表情]'
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

        return message
      })

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
   * 导出单个会话为详细 JSON 格式（原项目格式）- 并行优化版本
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

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? collected.rows.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      for (const msg of collected.rows) {
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 阶段1：并行导出媒体文件 ==========
      const mediaMessages = exportMediaEnabled
        ? collected.rows.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 43 && options.exportVideos) ||
            (t === 34 && options.exportVoices)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 15,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media'
        })

        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
        })
      }

      // ========== 阶段2：并行语音转文字 ==========
      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 35,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice'
        })

        const VOICE_CONCURRENCY = 4
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
        })
      }

      // ========== 预加载群昵称（用于名称显示偏好） ==========
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId)
        : new Map<string, string>()

      // ========== 阶段3：构建消息列表 ==========
      onProgress?.({
        current: 55,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const allMessages: any[] = []
      for (const msg of collected.rows) {
        const senderInfo = await this.getContactInfo(msg.senderUsername)
        const sourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(msg.content || '')
        const source = sourceMatch ? sourceMatch[0] : ''

        let content: string | null
        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey)

        if (msg.localType === 34 && options.exportVoiceAsText) {
          content = voiceTranscriptMap.get(msg.localId) || '[语音消息 - 转文字失败]'
        } else if (mediaItem) {
          content = mediaItem.relativePath
        } else {
          content = this.parseMessageContent(msg.content, msg.localType)
        }

        // 获取发送者信息用于名称显示
        const senderWxid = msg.senderUsername
        const contact = await getContactCached(senderWxid)
        const senderNickname = contact.success && contact.contact?.nickName
          ? contact.contact.nickName
          : (senderInfo.displayName || senderWxid)
        const senderRemark = contact.success && contact.contact?.remark ? contact.contact.remark : ''
        const senderGroupNickname = this.normalizeGroupNickname(groupNicknamesMap.get(senderWxid?.toLowerCase() || '') || '')

        // 使用用户偏好的显示名称
        const senderDisplayName = this.getPreferredDisplayName(
          senderWxid,
          senderNickname,
          senderRemark,
          senderGroupNickname,
          options.displayNamePreference || 'remark'
        )

        allMessages.push({
          localId: allMessages.length + 1,
          createTime: msg.createTime,
          formattedTime: this.formatTimestamp(msg.createTime),
          type: this.getMessageTypeName(msg.localType),
          localType: msg.localType,
          content,
          isSend: msg.isSend ? 1 : 0,
          senderUsername: msg.senderUsername,
          senderDisplayName,
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

      // 获取会话的昵称和备注信息
      const sessionContact = await getContactCached(sessionId)
      const sessionNickname = sessionContact.success && sessionContact.contact?.nickName
        ? sessionContact.contact.nickName
        : sessionInfo.displayName
      const sessionRemark = sessionContact.success && sessionContact.contact?.remark
        ? sessionContact.contact.remark
        : ''
      const sessionGroupNickname = isGroup
        ? this.normalizeGroupNickname(groupNicknamesMap.get(sessionId.toLowerCase()) || '')
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
      const detailedExport: any = {
        weflow,
        session: {
          wxid: sessionId,
          nickname: sessionNickname,
          remark: sessionRemark,
          displayName: sessionDisplayName,
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

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? collected.rows.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      for (const msg of collected.rows) {
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)

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
        : ['序号', '时间', '发送者昵称', '发送者微信ID', '发送者备注', '群昵称', '发送者身份', '消息类型', '内容']
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
        worksheet.getColumn(6).width = 18  // 群昵称
        worksheet.getColumn(7).width = 15  // 发送者身份
        worksheet.getColumn(8).width = 12  // 消息类型
        worksheet.getColumn(9).width = 50  // 内容
      }

      // 预加载群昵称 (仅群聊且完整列模式)
      const groupNicknamesMap = (isGroup && !useCompactColumns)
        ? await this.getGroupNicknamesForRoom(sessionId)
        : new Map<string, string>()


      // 填充数据
      const sortedMessages = collected.rows.sort((a, b) => a.createTime - b.createTime)

      // 媒体导出设置
      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 并行预处理：媒体文件 ==========
      const mediaMessages = exportMediaEnabled
        ? sortedMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 43 && options.exportVideos) ||
            (t === 34 && options.exportVoices)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 35,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media'
        })

        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
        })
      }

      // ========== 并行预处理：语音转文字 ==========
      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 50,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice'
        })

        const VOICE_CONCURRENCY = 4
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
        })
      }

      onProgress?.({
        current: 65,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      // ========== 写入 Excel 行 ==========
      for (let i = 0; i < sortedMessages.length; i++) {
        const msg = sortedMessages[i]

        // 确定发送者信息
        let senderRole: string
        let senderWxid: string
        let senderNickname: string
        let senderRemark: string = ''
        let senderGroupNickname: string = ''  // 群昵称


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
          const contactDetail = await getContactCached(msg.senderUsername)
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

        // 获取群昵称 (仅群聊且完整列模式)
        if (isGroup && !useCompactColumns && senderWxid) {
          senderGroupNickname = this.normalizeGroupNickname(groupNicknamesMap.get(senderWxid.toLowerCase()) || '')
        }


        const row = worksheet.getRow(currentRow)
        row.height = 24

        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey)
        const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
        const contentValue = shouldUseTranscript
          ? this.formatPlainExportContent(
            msg.content,
            msg.localType,
            options,
            voiceTranscriptMap.get(msg.localId)
          )
          : (mediaItem?.relativePath
            || this.formatPlainExportContent(
              msg.content,
              msg.localType,
              options,
              voiceTranscriptMap.get(msg.localId)
            ))

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
          worksheet.getCell(currentRow, 6).value = senderGroupNickname
          worksheet.getCell(currentRow, 7).value = senderRole
          worksheet.getCell(currentRow, 8).value = this.getMessageTypeName(msg.localType)
          worksheet.getCell(currentRow, 9).value = contentValue
        }

        // 设置每个单元格的样式
        const maxColumns = useCompactColumns ? 5 : 9
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
    * 确保语音转写模型已下载
    */
  private async ensureVoiceModel(onProgress?: (progress: ExportProgress) => void): Promise<boolean> {
    try {
      const status = await voiceTranscribeService.getModelStatus()
      if (status.success && status.exists) {
        return true
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: '正在下载 AI 模型',
        phase: 'preparing'
      })

      const downloadResult = await voiceTranscribeService.downloadModel((progress: any) => {
        if (progress.percent !== undefined) {
          onProgress?.({
            current: progress.percent,
            total: 100,
            currentSession: `正在下载 AI 模型 (${progress.percent.toFixed(0)}%)`,
            phase: 'preparing'
          })
        }
      })

      return downloadResult.success
    } catch (e) {
      console.error('Auto download model failed:', e)
      return false
    }
  }

  /**
   * 导出单个会话为 TXT 格式（默认与 Excel 精简列一致）
   */
  async exportSessionToTxt(
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

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? collected.rows.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      for (const msg of collected.rows) {
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)

      const sortedMessages = collected.rows.sort((a, b) => a.createTime - b.createTime)

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
      const mediaMessages = exportMediaEnabled
        ? sortedMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 43 && options.exportVideos) ||
            (t === 34 && options.exportVoices)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 25,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media'
        })

        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
        })
      }

      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 45,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice'
        })

        const VOICE_CONCURRENCY = 4
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
        })
      }

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const lines: string[] = []

      for (let i = 0; i < sortedMessages.length; i++) {
        const msg = sortedMessages[i]
        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey)
        const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
        const contentValue = shouldUseTranscript
          ? this.formatPlainExportContent(
            msg.content,
            msg.localType,
            options,
            voiceTranscriptMap.get(msg.localId)
          )
          : (mediaItem?.relativePath
            || this.formatPlainExportContent(
              msg.content,
              msg.localType,
              options,
              voiceTranscriptMap.get(msg.localId)
            ))

        let senderRole: string
        let senderWxid: string
        let senderNickname: string
        let senderRemark = ''

        if (msg.isSend) {
          senderRole = '我'
          senderWxid = cleanedMyWxid
          senderNickname = myInfo.displayName || cleanedMyWxid
        } else if (isGroup && msg.senderUsername) {
          senderWxid = msg.senderUsername
          const contactDetail = await getContactCached(msg.senderUsername)
          if (contactDetail.success && contactDetail.contact) {
            senderNickname = contactDetail.contact.nickName || msg.senderUsername
            senderRemark = contactDetail.contact.remark || ''
            senderRole = senderRemark || senderNickname
          } else {
            senderNickname = msg.senderUsername
            senderRole = msg.senderUsername
          }
        } else {
          senderWxid = sessionId
          const contactDetail = await getContactCached(sessionId)
          if (contactDetail.success && contactDetail.contact) {
            senderNickname = contactDetail.contact.nickName || sessionId
            senderRemark = contactDetail.contact.remark || ''
            senderRole = senderRemark || senderNickname
          } else {
            senderNickname = sessionInfo.displayName || sessionId
            senderRole = senderNickname
          }
        }

        lines.push(`${this.formatTimestamp(msg.createTime)} '${senderRole}'`)
        lines.push(contentValue)
        lines.push('')

        if ((i + 1) % 200 === 0) {
          const progress = 60 + Math.floor((i + 1) / sortedMessages.length * 30)
          onProgress?.({
            current: progress,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting'
          })
        }
      }

      onProgress?.({
        current: 92,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')

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

  private getVirtualScrollScript(): string {
    return `
      class VirtualScroller {
        constructor(container, list, data, renderItem) {
          this.container = container;
          this.list = list;
          this.data = data;
          this.renderItem = renderItem;
          
          this.rowHeight = 80; // Estimated height
          this.buffer = 5;
          this.heightCache = new Map();
          this.visibleItems = new Set();
          
          this.spacer = document.createElement('div');
          this.spacer.className = 'virtual-scroll-spacer';
          this.content = document.createElement('div');
          this.content.className = 'virtual-scroll-content';
          
          this.container.appendChild(this.spacer);
          this.container.appendChild(this.content);
          
          this.container.addEventListener('scroll', () => this.onScroll());
          window.addEventListener('resize', () => this.onScroll());
          
          this.updateTotalHeight();
          this.onScroll();
        }

        setData(newData) {
          this.data = newData;
          this.heightCache.clear();
          this.content.innerHTML = '';
          this.container.scrollTop = 0;
          this.updateTotalHeight();
          this.onScroll();
          
          // Show/Hide empty state
          if (this.data.length === 0) {
             this.content.innerHTML = '<div class="empty">暂无消息</div>';
          }
        }

        updateTotalHeight() {
          let total = 0;
          for (let i = 0; i < this.data.length; i++) {
            total += this.heightCache.get(i) || this.rowHeight;
          }
          this.spacer.style.height = total + 'px';
        }

        onScroll() {
          if (this.data.length === 0) return;

          const scrollTop = this.container.scrollTop;
          const containerHeight = this.container.clientHeight;
          
          // Find start index
          let currentY = 0;
          let startIndex = 0;
          for (let i = 0; i < this.data.length; i++) {
            const h = this.heightCache.get(i) || this.rowHeight;
            if (currentY + h > scrollTop) {
              startIndex = i;
              break;
            }
            currentY += h;
          }
          
          // Find end index
          let endIndex = startIndex;
          let visibleHeight = 0;
          for (let i = startIndex; i < this.data.length; i++) {
            const h = this.heightCache.get(i) || this.rowHeight;
            visibleHeight += h;
            endIndex = i;
            if (visibleHeight > containerHeight) break;
          }
          
          const start = Math.max(0, startIndex - this.buffer);
          const end = Math.min(this.data.length - 1, endIndex + this.buffer);
          
          this.renderRange(start, end, currentY);
        }

        renderRange(start, end, startY) {
          // Calculate offset for start item
          let topOffset = 0;
          for(let i=0; i<start; i++) {
             topOffset += this.heightCache.get(i) || this.rowHeight;
          }

          const newKeys = new Set();
          
          // Create or update items
          let currentTop = topOffset;
          const fragment = document.createDocumentFragment();

          for (let i = start; i <= end; i++) {
            newKeys.add(i);
            const itemData = this.data[i];
            
            let el = this.content.querySelector(\`[data-index="\${i}"]\`);
            if (!el) {
              el = document.createElement('div');
              el.setAttribute('data-index', i);
              el.className = 'virtual-item';
              el.style.position = 'absolute';
              el.style.left = '0';
              el.style.width = '100%';
              el.innerHTML = this.renderItem(itemData, i);
              
              // Measure height after render
              this.content.appendChild(el); 
              const rect = el.getBoundingClientRect();
              const actualHeight = rect.height;
              
              if (Math.abs(actualHeight - (this.heightCache.get(i) || this.rowHeight)) > 1) {
                this.heightCache.set(i, actualHeight);
                // If height changed significantly, we might need to adjust total height
                // But for performance, maybe just do it on next scroll or rarely?
                // For now, let's keep it simple. If we update inline style top, we need to know exact previous heights.
              }
            }
            
            el.style.top = currentTop + 'px';
            currentTop += (this.heightCache.get(i) || this.rowHeight);
          }
          
          // Cleanup
          Array.from(this.content.children).forEach(child => {
            if (child.classList.contains('empty')) return;
            const idx = parseInt(child.getAttribute('data-index'));
            if (!newKeys.has(idx)) {
              child.remove();
            }
          });
          
          this.updateTotalHeight();
        }
        
        scrollToTime(timestamp) {
           const idx = this.data.findIndex(item => item.ts >= timestamp);
           if (idx !== -1) {
             this.scrollToIndex(idx);
           }
        }
        
        scrollToIndex(index) {
          let top = 0;
          for(let i=0; i<index; i++) {
            top += this.heightCache.get(i) || this.rowHeight;
          }
          this.container.scrollTop = top;
        }
      }
    `;
  }

  /**
   * 导出单个会话为 HTML 格式
   */
  async exportSessionToHtml(
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

      if (options.exportVoiceAsText) {
        await this.ensureVoiceModel(onProgress)
      }

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      if (isGroup) {
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }
      const sortedMessages = collected.rows.sort((a, b) => a.createTime - b.createTime)

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
      const mediaMessages = exportMediaEnabled
        ? sortedMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 34 && options.exportVoices) ||
            (t === 43 && options.exportVideos)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 20,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media'
        })

        const MEDIA_CONCURRENCY = 6
        await parallelLimit(mediaMessages, MEDIA_CONCURRENCY, async (msg) => {
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText,
              includeVoiceWithTranscript: true,
              exportVideos: options.exportVideos
            })
            mediaCache.set(mediaKey, mediaItem)
          }
        })
      }

      const useVoiceTranscript = options.exportVoiceAsText !== false
      const voiceMessages = useVoiceTranscript
        ? sortedMessages.filter(msg => msg.localType === 34)
        : []
      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 40,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice'
        })

        const VOICE_CONCURRENCY = 4
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
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
          path.dirname(outputPath)
        )
        : new Map<string, string>()

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      // ================= BEGIN STREAM WRITING =================
      const exportMeta = this.getExportMeta(sessionId, sessionInfo, isGroup)
      const htmlStyles = this.loadExportHtmlStyles()
      const stream = fs.createWriteStream(outputPath, { encoding: 'utf-8' })

      const writePromise = (str: string) => {
        return new Promise<void>((resolve, reject) => {
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
    <title>${this.escapeHtml(sessionInfo.displayName)} - 聊天记录</title>
    <style>${htmlStyles}</style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <h1 class="title">${this.escapeHtml(sessionInfo.displayName)} 的聊天记录</h1>
        <div class="meta">
          <span>导出时间：${this.escapeHtml(this.formatTimestamp(exportMeta.chatlab.exportedAt))}</span>
          <span>消息数量：${sortedMessages.length}</span>
          <span>会话类型：${isGroup ? '群聊' : '私聊'}</span>
        </div>
        <div class="controls">
          <div class="control">
            <label for="searchInput">搜索内容 / 发送者</label>
            <input id="searchInput" type="search" placeholder="输入关键词实时过滤" />
          </div>
          <div class="control">
            <label for="timeInput">按时间跳转</label>
            <input id="timeInput" type="datetime-local" />
          </div>
          <div class="control">
            <label for="themeSelect">主题配色</label>
            <select id="themeSelect">
              <option value="cloud-dancer">云舞蓝</option>
              <option value="corundum-blue">珊瑚蓝</option>
              <option value="kiwi-green">奇异绿</option>
              <option value="spicy-red">热辣红</option>
              <option value="teal-water">蓝绿水</option>
            </select>
          </div>
          <div class="control">
            <label>&nbsp;</label>
            <button id="jumpBtn" type="button">跳转到时间</button>
          </div>
          <div class="stats">
            <span id="resultCount">共 ${sortedMessages.length} 条</span>
          </div>
        </div>
      </div>
      
      <!-- Virtual Scroll Container -->
      <div id="virtualScrollContainer" class="virtual-scroll-container"></div>
      
    </div>
    
    <div class="image-preview" id="imagePreview">
      <img id="imagePreviewTarget" alt="预览" />
    </div>

    <!-- Data Injection -->
    <script>
      window.WEFLOW_DATA = [
`);

      // Write messages in chunks
      for (let i = 0; i < sortedMessages.length; i++) {
        const msg = sortedMessages[i]
        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey) || null

        const isSenderMe = msg.isSend
        const senderInfo = collected.memberSet.get(msg.senderUsername)?.member
        const senderName = isSenderMe
          ? (myInfo.displayName || '我')
          : (isGroup
            ? (senderInfo?.groupNickname || senderInfo?.accountName || msg.senderUsername)
            : (sessionInfo.displayName || sessionId))
        const avatarData = avatarMap.get(isSenderMe ? cleanedMyWxid : msg.senderUsername)
        const avatarHtml = avatarData
          ? `<img src="${this.escapeAttribute(encodeURI(avatarData))}" alt="${this.escapeAttribute(senderName)}" />`
          : `<span>${this.escapeHtml(this.getAvatarFallback(senderName))}</span>`

        const timeText = this.formatTimestamp(msg.createTime)
        const typeName = this.getMessageTypeName(msg.localType)

        let textContent = this.formatHtmlMessageText(msg.content, msg.localType)
        if (msg.localType === 34 && useVoiceTranscript) {
          textContent = voiceTranscriptMap.get(msg.localId) || '[语音消息 - 转文字失败]'
        }
        if (mediaItem && (msg.localType === 3 || msg.localType === 47)) {
          textContent = ''
        }

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

        const textHtml = textContent
          ? `<div class="message-text">${this.renderTextWithEmoji(textContent).replace(/\r?\n/g, '<br />')}</div>`
          : ''
        const senderNameHtml = isGroup
          ? `<div class="sender-name">${this.escapeHtml(senderName)}</div>`
          : ''
        const timeHtml = `<div class="message-time">${this.escapeHtml(timeText)}</div>`
        const messageBody = `
            ${timeHtml}
            ${senderNameHtml}
            <div class="message-content">
              ${mediaHtml}
              ${textHtml}
            </div>
        `

        // Compact JSON object
        const itemObj = {
          i: i + 1, // index
          t: msg.createTime, // timestamp
          s: isSenderMe ? 1 : 0, // isSend
          a: avatarHtml, // avatar HTML
          b: messageBody // body HTML
        }

        const jsonStr = JSON.stringify(itemObj)
        await writePromise(jsonStr + (i < sortedMessages.length - 1 ? ',\n' : '\n'))

        // Report progress occasionally
        if ((i + 1) % 500 === 0) {
          onProgress?.({
            current: 60 + Math.floor((i + 1) / sortedMessages.length * 30),
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'writing'
          })
        }
      }

      await writePromise(`];
    </script>

    <script>
       ${this.getVirtualScrollScript()}

      const searchInput = document.getElementById('searchInput')
      const timeInput = document.getElementById('timeInput')
      const jumpBtn = document.getElementById('jumpBtn')
      const resultCount = document.getElementById('resultCount')
      const themeSelect = document.getElementById('themeSelect')
      const imagePreview = document.getElementById('imagePreview')
      const imagePreviewTarget = document.getElementById('imagePreviewTarget')
      const container = document.getElementById('virtualScrollContainer')
      let imageZoom = 1

      // Initial Data
      let allData = window.WEFLOW_DATA || [];
      let currentList = allData;

      // Render Item Function
      const renderItem = (item, index) => {
         const isSenderMe = item.s === 1;
         return \`
          <div class="message \${isSenderMe ? 'sent' : 'received'}" data-index="\${item.i}">
            <div class="message-row">
              <div class="avatar">\${item.a}</div>
              <div class="bubble">
                \${item.b}
              </div>
            </div>
          </div>
         \`;
      };
      
      const scroller = new VirtualScroller(container, [], currentList, renderItem);

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
            // Simplified search: check raw html content (contains body text and sender name)
            // Ideally we should search raw text, but we only have pre-rendered HTML in JSON 'b' (body)
            // 'b' contains message content and sender name.
            currentList = allData.filter(item => {
               return item.b.toLowerCase().includes(keyword); 
            });
          }
          scroller.setData(currentList);
          updateCount();
        }, 300);
      })

      // Jump Logic
      jumpBtn.addEventListener('click', () => {
        const value = timeInput.value
        if (!value) return
        const target = Math.floor(new Date(value).getTime() / 1000)
        // Find in current list
        scroller.scrollToTime(target);
      })

      // Theme Logic
      const applyTheme = (value) => {
        document.body.setAttribute('data-theme', value)
        localStorage.setItem('weflow-export-theme', value)
      }
      const storedTheme = localStorage.getItem('weflow-export-theme') || 'cloud-dancer'
      themeSelect.value = storedTheme
      applyTheme(storedTheme)

      themeSelect.addEventListener('change', (event) => {
        applyTheme(event.target.value)
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
      console.log('WeFlow Export Loaded', allData.length);
    </script>
  </body>
</html>`);

      return new Promise((resolve, reject) => {
        stream.end(() => {
          onProgress?.({
            current: 100,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'complete'
          })
          resolve({ success: true })
        })
        stream.on('error', reject)
      })

    } catch (e) {
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
        Boolean(options.exportImages || options.exportVoices || options.exportVideos || options.exportEmojis)
      const sessionLayout = exportMediaEnabled
        ? (options.sessionLayout ?? 'per-session')
        : 'shared'
      let completedCount = 0
      const rawConcurrency = typeof options.exportConcurrency === 'number'
        ? Math.floor(options.exportConcurrency)
        : 2
      const clampedConcurrency = Math.max(1, Math.min(rawConcurrency, 6))
      const sessionConcurrency = (exportMediaEnabled && sessionLayout === 'shared')
        ? 1
        : clampedConcurrency

      await parallelLimit(sessionIds, sessionConcurrency, async (sessionId) => {
        const sessionInfo = await this.getContactInfo(sessionId)

        onProgress?.({
          current: completedCount,
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
        else if (options.format === 'txt') ext = '.txt'
        else if (options.format === 'html') ext = '.html'
        const outputPath = path.join(sessionDir, `${safeName}${ext}`)

        let result: { success: boolean; error?: string }
        if (options.format === 'json') {
          result = await this.exportSessionToDetailedJson(sessionId, outputPath, options)
        } else if (options.format === 'chatlab' || options.format === 'chatlab-jsonl') {
          result = await this.exportSessionToChatLab(sessionId, outputPath, options)
        } else if (options.format === 'excel') {
          result = await this.exportSessionToExcel(sessionId, outputPath, options)
        } else if (options.format === 'txt') {
          result = await this.exportSessionToTxt(sessionId, outputPath, options)
        } else if (options.format === 'html') {
          result = await this.exportSessionToHtml(sessionId, outputPath, options)
        } else {
          result = { success: false, error: `不支持的格式: ${options.format}` }
        }

        if (result.success) {
          successCount++
        } else {
          failCount++
          console.error(`导出 ${sessionId} 失败:`, result.error)
        }

        completedCount++
        onProgress?.({
          current: completedCount,
          total: sessionIds.length,
          currentSession: sessionInfo.displayName,
          phase: 'exporting'
        })
      })

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
