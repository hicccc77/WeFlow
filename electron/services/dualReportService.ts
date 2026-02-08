import { parentPort } from 'worker_threads'
import { wcdbService } from './wcdbService'

export interface DualReportMessage {
  content: string
  isSentByMe: boolean
  createTime: number
  createTimeStr: string
}

export interface DualReportFirstChat {
  createTime: number
  createTimeStr: string
  content: string
  isSentByMe: boolean
  senderUsername?: string
}

export interface DualReportStats {
  totalMessages: number
  totalWords: number
  imageCount: number
  voiceCount: number
  emojiCount: number
  myTopEmojiMd5?: string
  friendTopEmojiMd5?: string
  myTopEmojiUrl?: string
  friendTopEmojiUrl?: string
  myTopEmojiCount?: number
  friendTopEmojiCount?: number
}

export interface DualReportData {
  year: number
  selfName: string
  selfAvatarUrl?: string
  friendUsername: string
  friendName: string
  friendAvatarUrl?: string
  firstChat: DualReportFirstChat | null
  firstChatMessages?: DualReportMessage[]
  yearFirstChat?: {
    createTime: number
    createTimeStr: string
    content: string
    isSentByMe: boolean
    friendName: string
    firstThreeMessages: DualReportMessage[]
  } | null
  stats: DualReportStats
  topPhrases: Array<{ phrase: string; count: number }>
  heatmap?: number[][]
  initiative?: { initiated: number; received: number }
  response?: { avg: number; fastest: number; count: number }
  monthly?: Record<string, number>
  streak?: { days: number; startDate: string; endDate: string }
}

class DualReportService {
  private broadcastProgress(status: string, progress: number) {
    if (parentPort) {
      parentPort.postMessage({
        type: 'dualReport:progress',
        data: { status, progress }
      })
    }
  }

  private reportProgress(status: string, progress: number, onProgress?: (status: string, progress: number) => void) {
    if (onProgress) {
      onProgress(status, progress)
      return
    }
    this.broadcastProgress(status, progress)
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

  private async ensureConnectedWithConfig(
    dbPath: string,
    decryptKey: string,
    wxid: string
  ): Promise<{ success: boolean; cleanedWxid?: string; rawWxid?: string; error?: string }> {
    if (!wxid) return { success: false, error: '未配置微信ID' }
    if (!dbPath) return { success: false, error: '未配置数据库路径' }
    if (!decryptKey) return { success: false, error: '未配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true, cleanedWxid, rawWxid: wxid }
  }

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
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
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

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  private formatDateTime(milliseconds: number): string {
    const dt = new Date(milliseconds)
    const month = String(dt.getMonth() + 1).padStart(2, '0')
    const day = String(dt.getDate()).padStart(2, '0')
    const hour = String(dt.getHours()).padStart(2, '0')
    const minute = String(dt.getMinutes()).padStart(2, '0')
    return `${month}/${day} ${hour}:${minute}`
  }

  private getRecordField(record: Record<string, any> | undefined | null, keys: string[]): any {
    if (!record) return undefined
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined && record[key] !== null) {
        return record[key]
      }
    }
    return undefined
  }

  private coerceNumber(raw: any): number {
    if (raw === undefined || raw === null || raw === '') return NaN
    if (typeof raw === 'number') return raw
    if (typeof raw === 'bigint') return Number(raw)
    if (Buffer.isBuffer(raw)) return parseInt(raw.toString('utf-8'), 10)
    if (raw instanceof Uint8Array) return parseInt(Buffer.from(raw).toString('utf-8'), 10)
    const parsed = parseInt(String(raw), 10)
    return Number.isFinite(parsed) ? parsed : NaN
  }

  private coerceString(raw: any): string {
    if (raw === undefined || raw === null) return ''
    if (typeof raw === 'string') return raw
    if (Buffer.isBuffer(raw)) return this.decodeBinaryContent(raw)
    if (raw instanceof Uint8Array) return this.decodeBinaryContent(Buffer.from(raw))
    return String(raw)
  }

  private coerceBoolean(raw: any): boolean | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'number') return raw !== 0

    const normalized = String(raw).trim().toLowerCase()
    if (!normalized) return undefined

    if (['1', 'true', 'yes', 'me', 'self', 'mine', 'sent', 'out', 'outgoing'].includes(normalized)) return true
    if (['0', 'false', 'no', 'friend', 'peer', 'other', 'recv', 'received', 'in', 'incoming'].includes(normalized)) return false
    return undefined
  }

  private normalizeEmojiMd5(raw: string): string | undefined {
    if (!raw) return undefined
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    const match = /([a-fA-F0-9]{16,64})/.exec(trimmed)
    return match ? match[1].toLowerCase() : undefined
  }

  private normalizeEmojiUrl(raw: string): string | undefined {
    if (!raw) return undefined
    let url = raw.trim().replace(/&amp;/g, '&')
    if (!url) return undefined
    try {
      if (url.includes('%')) {
        url = decodeURIComponent(url)
      }
    } catch { }
    return url || undefined
  }

  private extractEmojiUrl(content: string | undefined): string | undefined {
    if (!content) return undefined
    const direct = this.normalizeEmojiUrl(content)
    if (direct && /^https?:\/\//i.test(direct)) return direct

    const attrMatch = /(?:cdnurl|thumburl)\s*=\s*['"]([^'"]+)['"]/i.exec(content)
      || /(?:cdnurl|thumburl)\s*=\s*([^'"\s>]+)/i.exec(content)
    if (attrMatch) return this.normalizeEmojiUrl(attrMatch[1])

    const tagMatch = /<(?:cdnurl|thumburl)>([^<]+)<\/(?:cdnurl|thumburl)>/i.exec(content)
      || /(?:cdnurl|thumburl)[^>]*>([^<]+)/i.exec(content)
    return this.normalizeEmojiUrl(tagMatch?.[1] || '')
  }

  private extractEmojiMd5(content: string | undefined): string | undefined {
    if (!content) return undefined
    const direct = this.normalizeEmojiMd5(content)
    if (direct && direct.length >= 24) return direct

    const match = /md5\s*=\s*['"]([a-fA-F0-9]{16,64})['"]/i.exec(content)
      || /md5\s*=\s*([a-fA-F0-9]{16,64})/i.exec(content)
      || /<md5>([a-fA-F0-9]{16,64})<\/md5>/i.exec(content)
    return this.normalizeEmojiMd5(match?.[1] || '')
  }

  private resolveEmojiOwner(item: any, content: string): boolean | undefined {
    const sentFlag = this.coerceBoolean(this.getRecordField(item, [
      'isMe',
      'is_me',
      'isSent',
      'is_sent',
      'isSend',
      'is_send',
      'fromMe',
      'from_me'
    ]))
    if (sentFlag !== undefined) return sentFlag

    const sideRaw = this.coerceString(this.getRecordField(item, ['side', 'sender', 'from', 'owner', 'role', 'direction'])).trim().toLowerCase()
    if (sideRaw) {
      if (['me', 'self', 'mine', 'out', 'outgoing', 'sent'].includes(sideRaw)) return true
      if (['friend', 'peer', 'other', 'in', 'incoming', 'received', 'recv'].includes(sideRaw)) return false
    }

    const prefixMatch = /^\s*([01])\s*:\s*/.exec(content)
    if (prefixMatch) return prefixMatch[1] === '1'
    return undefined
  }

  private stripEmojiOwnerPrefix(content: string): string {
    if (!content) return ''
    return content.replace(/^\s*[01]\s*:\s*/, '')
  }

  private parseEmojiCandidate(item: any): { isMe?: boolean; md5?: string; url?: string; count: number } {
    const rawContent = this.coerceString(this.getRecordField(item, [
      'content',
      'xml',
      'message_content',
      'messageContent',
      'msg',
      'payload',
      'raw'
    ]))
    const content = this.stripEmojiOwnerPrefix(rawContent)

    const countRaw = this.getRecordField(item, ['count', 'cnt', 'times', 'total', 'num'])
    const parsedCount = this.coerceNumber(countRaw)
    const count = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 0

    const directMd5 = this.normalizeEmojiMd5(this.coerceString(this.getRecordField(item, [
      'md5',
      'emojiMd5',
      'emoji_md5',
      'emd5'
    ])))
    const md5 = directMd5 || this.extractEmojiMd5(content)

    const directUrl = this.normalizeEmojiUrl(this.coerceString(this.getRecordField(item, [
      'cdnUrl',
      'cdnurl',
      'emojiUrl',
      'emoji_url',
      'url',
      'thumbUrl',
      'thumburl'
    ])))
    const url = directUrl || this.extractEmojiUrl(content)

    return {
      isMe: this.resolveEmojiOwner(item, rawContent),
      md5,
      url,
      count
    }
  }

  private getRowInt(row: Record<string, any>, keys: string[], fallback = 0): number {
    const raw = this.getRecordField(row, keys)
    const parsed = this.coerceNumber(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private decodeRowMessageContent(row: Record<string, any>): string {
    const messageContent = this.getRecordField(row, [
      'message_content',
      'messageContent',
      'content',
      'msg_content',
      'msgContent',
      'WCDB_CT_message_content',
      'WCDB_CT_messageContent'
    ])
    const compressContent = this.getRecordField(row, [
      'compress_content',
      'compressContent',
      'compressed_content',
      'WCDB_CT_compress_content',
      'WCDB_CT_compressContent'
    ])
    return this.decodeMessageContent(messageContent, compressContent)
  }

  private async scanEmojiTopFallback(
    sessionId: string,
    beginTimestamp: number,
    endTimestamp: number,
    rawWxid: string,
    cleanedWxid: string
  ): Promise<{ my?: { md5: string; url?: string; count: number }; friend?: { md5: string; url?: string; count: number } }> {
    const cursorResult = await wcdbService.openMessageCursor(sessionId, 500, true, beginTimestamp, endTimestamp)
    if (!cursorResult.success || !cursorResult.cursor) return {}

    const tallyMap = new Map<string, { isMe: boolean; md5: string; url?: string; count: number }>()
    try {
      let hasMore = true
      while (hasMore) {
        const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
        if (!batch.success || !Array.isArray(batch.rows)) break

        for (const row of batch.rows) {
          const localType = this.getRowInt(row, ['local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'], 0)
          if (localType !== 47) continue

          const rawContent = this.decodeRowMessageContent(row)
          const content = this.stripEmojiOwnerPrefix(rawContent)
          const directMd5 = this.normalizeEmojiMd5(this.coerceString(this.getRecordField(row, ['emoji_md5', 'emojiMd5', 'md5'])))
          const md5 = directMd5 || this.extractEmojiMd5(content)
          if (!md5) continue

          const directUrl = this.normalizeEmojiUrl(this.coerceString(this.getRecordField(row, [
            'emoji_cdn_url',
            'emojiCdnUrl',
            'cdnurl',
            'cdn_url',
            'emoji_url',
            'emojiUrl',
            'url',
            'thumburl',
            'thumb_url'
          ])))
          const url = directUrl || this.extractEmojiUrl(content)
          const isMe = this.resolveIsSent(row, rawWxid, cleanedWxid)
          const mapKey = `${isMe ? '1' : '0'}:${md5}`
          const existing = tallyMap.get(mapKey)
          if (existing) {
            existing.count += 1
            if (!existing.url && url) existing.url = url
          } else {
            tallyMap.set(mapKey, { isMe, md5, url, count: 1 })
          }
        }
        hasMore = batch.hasMore === true
      }
    } finally {
      await wcdbService.closeMessageCursor(cursorResult.cursor)
    }

    let myTop: { md5: string; url?: string; count: number } | undefined
    let friendTop: { md5: string; url?: string; count: number } | undefined
    for (const entry of tallyMap.values()) {
      if (entry.isMe) {
        if (!myTop || entry.count > myTop.count) {
          myTop = { md5: entry.md5, url: entry.url, count: entry.count }
        }
      } else if (!friendTop || entry.count > friendTop.count) {
        friendTop = { md5: entry.md5, url: entry.url, count: entry.count }
      }
    }

    return { my: myTop, friend: friendTop }
  }

  private async getDisplayName(username: string, fallback: string): Promise<string> {
    const result = await wcdbService.getDisplayNames([username])
    if (result.success && result.map) {
      return result.map[username] || fallback
    }
    return fallback
  }

  private resolveIsSent(row: any, rawWxid?: string, cleanedWxid?: string): boolean {
    const isSendRaw = row.computed_is_send ?? row.is_send
    if (isSendRaw !== undefined && isSendRaw !== null) {
      return parseInt(isSendRaw, 10) === 1
    }
    const sender = String(row.sender_username || row.sender || row.talker || '').toLowerCase()
    if (!sender) return false
    const rawLower = rawWxid ? rawWxid.toLowerCase() : ''
    const cleanedLower = cleanedWxid ? cleanedWxid.toLowerCase() : ''
    return !!(
      sender === rawLower ||
      sender === cleanedLower ||
      (rawLower && rawLower.startsWith(sender + '_')) ||
      (cleanedLower && cleanedLower.startsWith(sender + '_'))
    )
  }

  private async getFirstMessages(
    sessionId: string,
    limit: number,
    beginTimestamp: number,
    endTimestamp: number
  ): Promise<any[]> {
    const safeBegin = Math.max(0, beginTimestamp || 0)
    const safeEnd = endTimestamp && endTimestamp > 0 ? endTimestamp : Math.floor(Date.now() / 1000)
    const cursorResult = await wcdbService.openMessageCursor(sessionId, Math.max(1, limit), true, safeBegin, safeEnd)
    if (!cursorResult.success || !cursorResult.cursor) return []
    try {
      const rows: any[] = []
      let hasMore = true
      while (hasMore && rows.length < limit) {
        const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
        if (!batch.success || !batch.rows) break
        for (const row of batch.rows) {
          rows.push(row)
          if (rows.length >= limit) break
        }
        hasMore = batch.hasMore === true
      }
      return rows.slice(0, limit)
    } finally {
      await wcdbService.closeMessageCursor(cursorResult.cursor)
    }
  }

  async generateReportWithConfig(params: {
    year: number
    friendUsername: string
    dbPath: string
    decryptKey: string
    wxid: string
    onProgress?: (status: string, progress: number) => void
  }): Promise<{ success: boolean; data?: DualReportData; error?: string }> {
    try {
      const { year, friendUsername, dbPath, decryptKey, wxid, onProgress } = params
      this.reportProgress('正在连接数据库...', 5, onProgress)
      const conn = await this.ensureConnectedWithConfig(dbPath, decryptKey, wxid)
      if (!conn.success || !conn.cleanedWxid || !conn.rawWxid) return { success: false, error: conn.error }

      const cleanedWxid = conn.cleanedWxid
      const rawWxid = conn.rawWxid

      const reportYear = year <= 0 ? 0 : year
      const isAllTime = reportYear === 0
      const startTime = isAllTime ? 0 : Math.floor(new Date(reportYear, 0, 1).getTime() / 1000)
      const endTime = isAllTime ? 0 : Math.floor(new Date(reportYear, 11, 31, 23, 59, 59).getTime() / 1000)

      this.reportProgress('加载联系人信息...', 10, onProgress)
      const friendName = await this.getDisplayName(friendUsername, friendUsername)
      let myName = await this.getDisplayName(rawWxid, rawWxid)
      if (myName === rawWxid && cleanedWxid && cleanedWxid !== rawWxid) {
        myName = await this.getDisplayName(cleanedWxid, rawWxid)
      }
      const avatarCandidates = Array.from(new Set([
        friendUsername,
        rawWxid,
        cleanedWxid
      ].filter(Boolean) as string[]))
      let selfAvatarUrl: string | undefined
      let friendAvatarUrl: string | undefined
      const avatarResult = await wcdbService.getAvatarUrls(avatarCandidates)
      if (avatarResult.success && avatarResult.map) {
        selfAvatarUrl = avatarResult.map[rawWxid] || avatarResult.map[cleanedWxid]
        friendAvatarUrl = avatarResult.map[friendUsername]
      }

      this.reportProgress('获取首条聊天记录...', 15, onProgress)
      const firstRows = await this.getFirstMessages(friendUsername, 3, 0, 0)
      let firstChat: DualReportFirstChat | null = null
      if (firstRows.length > 0) {
        const row = firstRows[0]
        const createTime = parseInt(row.create_time || '0', 10) * 1000
        const content = this.decodeMessageContent(row.message_content, row.compress_content)
        firstChat = {
          createTime,
          createTimeStr: this.formatDateTime(createTime),
          content: String(content || ''),
          isSentByMe: this.resolveIsSent(row, rawWxid, cleanedWxid),
          senderUsername: row.sender_username || row.sender
        }
      }
      const firstChatMessages: DualReportMessage[] = firstRows.map((row) => {
        const msgTime = parseInt(row.create_time || '0', 10) * 1000
        const msgContent = this.decodeMessageContent(row.message_content, row.compress_content)
        return {
          content: String(msgContent || ''),
          isSentByMe: this.resolveIsSent(row, rawWxid, cleanedWxid),
          createTime: msgTime,
          createTimeStr: this.formatDateTime(msgTime)
        }
      })

      let yearFirstChat: DualReportData['yearFirstChat'] = null
      if (!isAllTime) {
        this.reportProgress('获取今年首次聊天...', 20, onProgress)
        const firstYearRows = await this.getFirstMessages(friendUsername, 3, startTime, endTime)
        if (firstYearRows.length > 0) {
          const firstRow = firstYearRows[0]
          const createTime = parseInt(firstRow.create_time || '0', 10) * 1000
          const firstThreeMessages: DualReportMessage[] = firstYearRows.map((row) => {
            const msgTime = parseInt(row.create_time || '0', 10) * 1000
            const msgContent = this.decodeMessageContent(row.message_content, row.compress_content)
            return {
              content: String(msgContent || ''),
              isSentByMe: this.resolveIsSent(row, rawWxid, cleanedWxid),
              createTime: msgTime,
              createTimeStr: this.formatDateTime(msgTime)
            }
          })
          yearFirstChat = {
            createTime,
            createTimeStr: this.formatDateTime(createTime),
            content: String(this.decodeMessageContent(firstRow.message_content, firstRow.compress_content) || ''),
            isSentByMe: this.resolveIsSent(firstRow, rawWxid, cleanedWxid),
            friendName,
            firstThreeMessages
          }
        }
      }

      this.reportProgress('统计聊天数据...', 30, onProgress)

      const statsResult = await wcdbService.getDualReportStats(friendUsername, startTime, endTime)
      if (!statsResult.success || !statsResult.data) {
        return { success: false, error: statsResult.error || '获取双人报告统计失败' }
      }

      const cppData = statsResult.data
      const counts = cppData.counts || {}

      const stats: DualReportStats = {
        totalMessages: counts.total || 0,
        totalWords: counts.words || 0,
        imageCount: counts.image || 0,
        voiceCount: counts.voice || 0,
        emojiCount: counts.emoji || 0
      }

      // Process Emojis to find top for me and friend
      let myTopEmojiMd5: string | undefined
      let myTopEmojiUrl: string | undefined
      let myTopCount = -1

      let friendTopEmojiMd5: string | undefined
      let friendTopEmojiUrl: string | undefined
      let friendTopCount = -1

      if (cppData.emojis && Array.isArray(cppData.emojis)) {
        for (const item of cppData.emojis) {
          const candidate = this.parseEmojiCandidate(item)
          if (!candidate.md5 || candidate.isMe === undefined || candidate.count <= 0) continue

          if (candidate.isMe) {
            if (candidate.count > myTopCount) {
              myTopCount = candidate.count
              myTopEmojiMd5 = candidate.md5
              myTopEmojiUrl = candidate.url
            }
          } else if (candidate.count > friendTopCount) {
            friendTopCount = candidate.count
            friendTopEmojiMd5 = candidate.md5
            friendTopEmojiUrl = candidate.url
          }
        }
      }

      const needsEmojiFallback = stats.emojiCount > 0 && (!myTopEmojiMd5 || !friendTopEmojiMd5)
      if (needsEmojiFallback) {
        const fallback = await this.scanEmojiTopFallback(friendUsername, startTime, endTime, rawWxid, cleanedWxid)

        if (!myTopEmojiMd5 && fallback.my?.md5) {
          myTopEmojiMd5 = fallback.my.md5
          myTopEmojiUrl = myTopEmojiUrl || fallback.my.url
          myTopCount = fallback.my.count
        }
        if (!friendTopEmojiMd5 && fallback.friend?.md5) {
          friendTopEmojiMd5 = fallback.friend.md5
          friendTopEmojiUrl = friendTopEmojiUrl || fallback.friend.url
          friendTopCount = fallback.friend.count
        }
      }

      const [myEmojiUrlResult, friendEmojiUrlResult] = await Promise.all([
        myTopEmojiMd5 && !myTopEmojiUrl ? wcdbService.getEmoticonCdnUrl(dbPath, myTopEmojiMd5) : Promise.resolve(null),
        friendTopEmojiMd5 && !friendTopEmojiUrl ? wcdbService.getEmoticonCdnUrl(dbPath, friendTopEmojiMd5) : Promise.resolve(null)
      ])
      if (myEmojiUrlResult?.success && myEmojiUrlResult.url) myTopEmojiUrl = myEmojiUrlResult.url
      if (friendEmojiUrlResult?.success && friendEmojiUrlResult.url) friendTopEmojiUrl = friendEmojiUrlResult.url

      stats.myTopEmojiMd5 = myTopEmojiMd5
      stats.myTopEmojiUrl = myTopEmojiUrl
      stats.friendTopEmojiMd5 = friendTopEmojiMd5
      stats.friendTopEmojiUrl = friendTopEmojiUrl
      if (myTopCount >= 0) stats.myTopEmojiCount = myTopCount
      if (friendTopCount >= 0) stats.friendTopEmojiCount = friendTopCount

      const topPhrases = (cppData.phrases || []).map((p: any) => ({
        phrase: p.phrase,
        count: p.count
      }))

      // Attach extra stats to the data object (needs interface update if strictly typed, but data is flexible)
      const reportData: DualReportData = {
        year: reportYear,
        selfName: myName,
        selfAvatarUrl,
        friendUsername,
        friendName,
        friendAvatarUrl,
        firstChat,
        firstChatMessages,
        yearFirstChat,
        stats,
        topPhrases,
        // Append new C++ stats
        heatmap: cppData.heatmap,
        initiative: cppData.initiative,
        response: cppData.response,
        monthly: cppData.monthly,
        streak: cppData.streak
      } as any // Use as any to bypass strict type check for new fields, or update interface

      this.reportProgress('双人报告生成完成', 100, onProgress)
      return { success: true, data: reportData }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const dualReportService = new DualReportService()
