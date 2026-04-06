import * as fs from 'fs'
import * as path from 'path'
import ExcelJS from 'exceljs'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { chatService } from './chatService'
import type { Message } from './chatService'
import type { ChatStatistics } from './analyticsService'

export interface GroupChatInfo {
  username: string
  displayName: string
  memberCount: number
  avatarUrl?: string
}

export interface GroupMember {
  username: string
  displayName: string
  avatarUrl?: string
  nickname?: string
  alias?: string
  remark?: string
  groupNickname?: string
  isOwner?: boolean
}

export interface GroupMembersPanelEntry extends GroupMember {
  isFriend: boolean
  messageCount: number
}

export interface GroupMessageRank {
  member: GroupMember
  messageCount: number
}

export interface GroupActiveHours {
  hourlyDistribution: Record<number, number>
}

export interface MediaTypeCount {
  type: number
  name: string
  count: number
}

export interface GroupMediaStats {
  typeCounts: MediaTypeCount[]
  total: number
}

export interface GroupMemberAnalytics {
  statistics: ChatStatistics
  timeDistribution: Record<number, number>
  commonPhrases?: Array<{ phrase: string; count: number }>
  commonEmojis?: Array<{ emoji: string; count: number }>
}

export interface GroupMemberMessagesPage {
  messages: Message[]
  hasMore: boolean
  nextCursor: number
}

interface GroupMemberContactInfo {
  remark: string
  nickName: string
  alias: string
  username: string
  userName: string
  encryptUsername: string
  encryptUserName: string
  localType: number
}

class GroupAnalyticsService {
  private configService: ConfigService
  private readonly groupMembersPanelCacheTtlMs = 10 * 60 * 1000
  private readonly groupMembersPanelMembersTimeoutMs = 12 * 1000
  private readonly groupMembersPanelFullTimeoutMs = 25 * 1000
  private readonly groupMembersPanelCache = new Map<string, { updatedAt: number; data: GroupMembersPanelEntry[] }>()
  private readonly groupMembersPanelInFlight = new Map<
    string,
    Promise<{ success: boolean; data?: GroupMembersPanelEntry[]; error?: string; fromCache?: boolean; updatedAt?: number }>
  >()
  private readonly friendExcludeNames = new Set(['medianote', 'floatbottle', 'qmessage', 'qqmail', 'fmessage'])

  constructor() {
    this.configService = new ConfigService()
  }

  // 并发控制：限制同时执行的 Promise 数量
  private async parallelLimit<T, R>(
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

    const workers = Array(Math.min(limit, items.length))
      .fill(null)
      .map(() => runNext())

    await Promise.all(workers)
    return results
  }

  private cleanAccountDirName(name: string): string {
    const trimmed = name.trim()
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

  private resolveMemberUsername(
    candidate: unknown,
    memberLookup: Map<string, string>
  ): string | null {
    if (typeof candidate !== 'string') return null
    const raw = candidate.trim()
    if (!raw) return null
    if (memberLookup.has(raw)) return memberLookup.get(raw) || null
    const cleaned = this.cleanAccountDirName(raw)
    if (memberLookup.has(cleaned)) return memberLookup.get(cleaned) || null

    const parts = raw.split(/[,\s;|]+/).filter(Boolean)
    for (const part of parts) {
      if (memberLookup.has(part)) return memberLookup.get(part) || null
      const normalizedPart = this.cleanAccountDirName(part)
      if (memberLookup.has(normalizedPart)) return memberLookup.get(normalizedPart) || null
    }

    if ((raw.startsWith('{') || raw.startsWith('[')) && raw.length < 4096) {
      try {
        const parsed = JSON.parse(raw)
        return this.extractOwnerUsername(parsed, memberLookup, 0)
      } catch {
        return null
      }
    }

    return null
  }

  private extractOwnerUsername(
    value: unknown,
    memberLookup: Map<string, string>,
    depth: number
  ): string | null {
    if (depth > 4 || value == null) return null
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return null

    if (typeof value === 'string') {
      return this.resolveMemberUsername(value, memberLookup)
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const owner = this.extractOwnerUsername(item, memberLookup, depth + 1)
        if (owner) return owner
      }
      return null
    }

    if (typeof value !== 'object') return null
    const row = value as Record<string, unknown>

    for (const [key, entry] of Object.entries(row)) {
      const keyLower = key.toLowerCase()
      if (!keyLower.includes('owner') && !keyLower.includes('host') && !keyLower.includes('creator')) {
        continue
      }

      if (typeof entry === 'boolean') {
        if (entry && typeof row.username === 'string') {
          const owner = this.resolveMemberUsername(row.username, memberLookup)
          if (owner) return owner
        }
        continue
      }

      const owner = this.extractOwnerUsername(entry, memberLookup, depth + 1)
      if (owner) return owner
    }

    return null
  }

  private async detectGroupOwnerUsername(
    chatroomId: string,
    members: Array<{ username: string; [key: string]: unknown }>
  ): Promise<string | undefined> {
    const memberLookup = new Map<string, string>()
    for (const member of members) {
      const username = String(member.username || '').trim()
      if (!username) continue
      const cleaned = this.cleanAccountDirName(username)
      memberLookup.set(username, username)
      memberLookup.set(cleaned, username)
    }
    if (memberLookup.size === 0) return undefined

    const tryResolve = (candidate: unknown): string | undefined => {
      const owner = this.extractOwnerUsername(candidate, memberLookup, 0)
      return owner || undefined
    }

    for (const member of members) {
      const owner = tryResolve(member)
      if (owner) return owner
    }

    try {
      const groupContact = await wcdbService.getContact(chatroomId)
      if (groupContact.success && groupContact.contact) {
        const owner = tryResolve(groupContact.contact)
        if (owner) return owner
      }
    } catch {
      // ignore
    }

    try {
      const roomExt = await wcdbService.getChatRoomExtBuffer(chatroomId)
      if (roomExt.success && roomExt.extBuffer) {
        const owner = tryResolve({ ext_buffer: roomExt.extBuffer })
        if (owner) return owner
      }
    } catch {
      // ignore
    }

    return undefined
  }

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '未配置微信ID' }
    if (!dbPath) return { success: false, error: '未配置数据库路径' }
    if (!decryptKey) return { success: false, error: '未配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true }
  }

  /**
   * 从后端获取群成员群昵称，并在前端进行唯一性净化防串号。
   */
  private async getGroupNicknamesForRoom(chatroomId: string, candidates: string[] = []): Promise<Map<string, string>> {
    try {
      const dllResult = await wcdbService.getGroupNicknames(chatroomId)
      if (!dllResult.success || !dllResult.nicknames) {
        return new Map<string, string>()
      }
      return this.buildTrustedGroupNicknameMap(Object.entries(dllResult.nicknames), candidates)
    } catch (e) {
      console.error('getGroupNicknamesForRoom service error:', e)
      return new Map<string, string>()
    }
  }

  private normalizeGroupNicknameIdentity(value: string): string {
    const raw = String(value || '').trim()
    if (!raw) return ''
    return raw.toLowerCase()
  }

  private buildTrustedGroupNicknameMap(
    entries: Iterable<[string, string]>,
    candidates: string[] = []
  ): Map<string, string> {
    const candidateSet = new Set(
      this.buildGroupNicknameIdCandidates(candidates)
        .map((id) => this.normalizeGroupNicknameIdentity(id))
        .filter(Boolean)
    )

    const buckets = new Map<string, Set<string>>()
    for (const [memberIdRaw, nicknameRaw] of entries) {
      const identity = this.normalizeGroupNicknameIdentity(memberIdRaw || '')
      if (!identity) continue
      if (candidateSet.size > 0 && !candidateSet.has(identity)) continue

      const nickname = this.normalizeGroupNickname(nicknameRaw || '')
      if (!nickname) continue

      const slot = buckets.get(identity)
      if (slot) {
        slot.add(nickname)
      } else {
        buckets.set(identity, new Set([nickname]))
      }
    }

    const trusted = new Map<string, string>()
    for (const [identity, nicknameSet] of buckets.entries()) {
      if (nicknameSet.size !== 1) continue
      trusted.set(identity, Array.from(nicknameSet)[0])
    }
    return trusted
  }

  private mergeGroupNicknameEntries(
    target: Map<string, string>,
    entries: Iterable<[string, string]>
  ): void {
    for (const [memberIdRaw, nicknameRaw] of entries) {
      const nickname = this.normalizeGroupNickname(nicknameRaw || '')
      if (!nickname) continue
      for (const alias of this.buildIdCandidates([memberIdRaw])) {
        if (!alias) continue
        if (!target.has(alias)) target.set(alias, nickname)
        const lower = alias.toLowerCase()
        if (!target.has(lower)) target.set(lower, nickname)
      }
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

  private decodeExtBuffer(value: unknown): Buffer | null {
    if (!value) return null
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)

    if (typeof value === 'string') {
      const raw = value.trim()
      if (!raw) return null

      if (this.looksLikeHex(raw)) {
        try { return Buffer.from(raw, 'hex') } catch { }
      }
      if (this.looksLikeBase64(raw)) {
        try { return Buffer.from(raw, 'base64') } catch { }
      }

      try { return Buffer.from(raw, 'hex') } catch { }
      try { return Buffer.from(raw, 'base64') } catch { }
      try { return Buffer.from(raw, 'utf8') } catch { }
      return null
    }

    return null
  }

  private readVarint(buffer: Buffer, offset: number, limit: number = buffer.length): { value: number; next: number } | null {
    let value = 0
    let shift = 0
    let pos = offset
    while (pos < limit && shift <= 53) {
      const byte = buffer[pos]
      value += (byte & 0x7f) * Math.pow(2, shift)
      pos += 1
      if ((byte & 0x80) === 0) return { value, next: pos }
      shift += 7
    }
    return null
  }

  private isLikelyMemberId(value: string): boolean {
    const id = String(value || '').trim()
    if (!id) return false
    if (id.includes('@chatroom')) return false
    if (id.length < 4 || id.length > 80) return false
    return /^[A-Za-z][A-Za-z0-9_.@-]*$/.test(id)
  }

  private isLikelyNickname(value: string): boolean {
    const cleaned = this.normalizeGroupNickname(value)
    if (!cleaned) return false
    if (/^wxid_[a-z0-9_]+$/i.test(cleaned)) return false
    if (cleaned.includes('@chatroom')) return false
    if (!/[\u4E00-\u9FFF\u3400-\u4DBF\w]/.test(cleaned)) return false
    if (cleaned.length === 1) {
      const code = cleaned.charCodeAt(0)
      const isCjk = code >= 0x3400 && code <= 0x9fff
      if (!isCjk) return false
    }
    return true
  }

  private parseGroupNicknamesFromExtBuffer(buffer: Buffer, candidates: string[] = []): Map<string, string> {
    const nicknameMap = new Map<string, string>()
    if (!buffer || buffer.length === 0) return nicknameMap

    try {
      const candidateSet = new Set(this.buildIdCandidates(candidates).map((id) => id.toLowerCase()))

      for (let i = 0; i < buffer.length - 2; i += 1) {
        if (buffer[i] !== 0x0a) continue

        const idLenInfo = this.readVarint(buffer, i + 1)
        if (!idLenInfo) continue
        const idLen = idLenInfo.value
        if (!Number.isFinite(idLen) || idLen <= 0 || idLen > 96) continue

        const idStart = idLenInfo.next
        const idEnd = idStart + idLen
        if (idEnd > buffer.length) continue

        const memberId = buffer.toString('utf8', idStart, idEnd).trim()
        if (!this.isLikelyMemberId(memberId)) continue

        const memberIdLower = memberId.toLowerCase()
        if (candidateSet.size > 0 && !candidateSet.has(memberIdLower)) {
          i = idEnd - 1
          continue
        }

        const cursor = idEnd
        if (cursor >= buffer.length || buffer[cursor] !== 0x12) {
          i = idEnd - 1
          continue
        }

        const nickLenInfo = this.readVarint(buffer, cursor + 1)
        if (!nickLenInfo) {
          i = idEnd - 1
          continue
        }

        const nickLen = nickLenInfo.value
        if (!Number.isFinite(nickLen) || nickLen <= 0 || nickLen > 128) {
          i = idEnd - 1
          continue
        }

        const nickStart = nickLenInfo.next
        const nickEnd = nickStart + nickLen
        if (nickEnd > buffer.length) {
          i = idEnd - 1
          continue
        }

        const rawNick = buffer.toString('utf8', nickStart, nickEnd)
        const nickname = this.normalizeGroupNickname(rawNick.replace(/[\x00-\x1F\x7F]/g, '').trim())
        if (!this.isLikelyNickname(nickname)) {
          i = nickEnd - 1
          continue
        }

        if (!nicknameMap.has(memberId)) nicknameMap.set(memberId, nickname)
        if (!nicknameMap.has(memberIdLower)) nicknameMap.set(memberIdLower, nickname)
        i = nickEnd - 1
      }
    } catch (e) {
      console.error('Failed to parse chat_room.ext_buffer:', e)
    }

    return nicknameMap
  }

  private escapeCsvValue(value: string): string {
    if (value == null) return ''
    const str = String(value)
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  private normalizeGroupNickname(value: string): string {
    const trimmed = (value || '').trim()
    if (!trimmed) return ''
    if (/^["'@]+$/.test(trimmed)) return ''
    return trimmed
  }

  private buildIdCandidates(values: Array<string | undefined | null>): string[] {
    const set = new Set<string>()
    for (const rawValue of values) {
      const raw = String(rawValue || '').trim()
      if (!raw) continue
      set.add(raw)
      const cleaned = this.cleanAccountDirName(raw)
      if (cleaned && cleaned !== raw) {
        set.add(cleaned)
      }
    }
    return Array.from(set)
  }

  private buildGroupNicknameIdCandidates(values: Array<string | undefined | null>): string[] {
    const set = new Set<string>()
    for (const rawValue of values) {
      const raw = String(rawValue || '').trim()
      if (!raw) continue
      set.add(raw)
    }
    return Array.from(set)
  }

  private toNonNegativeInteger(value: unknown): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return 0
    return Math.max(0, Math.floor(parsed))
  }

  private pickStringField(row: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = row[key]
      if (value == null) continue
      const text = String(value).trim()
      if (text) return text
    }
    return ''
  }

  private pickIntegerField(row: Record<string, unknown>, keys: string[], fallback: number = 0): number {
    for (const key of keys) {
      const value = row[key]
      if (value == null || value === '') continue
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return Math.floor(parsed)
    }
    return fallback
  }

  private buildGroupMembersPanelCacheKey(chatroomId: string, includeMessageCounts: boolean): string {
    const dbPath = String(this.configService.get('dbPath') || '').trim()
    const wxid = this.cleanAccountDirName(String(this.configService.get('myWxid') || '').trim())
    const mode = includeMessageCounts ? 'full' : 'members'
    return `${dbPath}::${wxid}::${chatroomId}::${mode}`
  }

  private pruneGroupMembersPanelCache(maxEntries: number = 80): void {
    if (this.groupMembersPanelCache.size <= maxEntries) return
    const entries = Array.from(this.groupMembersPanelCache.entries())
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    const removeCount = this.groupMembersPanelCache.size - maxEntries
    for (let i = 0; i < removeCount; i += 1) {
      this.groupMembersPanelCache.delete(entries[i][0])
    }
  }

  private async withPromiseTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutResult: T
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutTimer = setTimeout(() => {
        resolve(timeoutResult)
      }, timeoutMs)
    })

    try {
      return await Promise.race([promise, timeoutPromise])
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
    }
  }

  private async buildGroupMemberContactLookup(usernames: string[]): Promise<Map<string, GroupMemberContactInfo>> {
    const lookup = new Map<string, GroupMemberContactInfo>()
    const candidates = this.buildIdCandidates(usernames)
    if (candidates.length === 0) return lookup

    const appendContactsToLookup = (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const contact: GroupMemberContactInfo = {
          remark: this.pickStringField(row, ['remark', 'WCDB_CT_remark']),
          nickName: this.pickStringField(row, ['nick_name', 'nickName', 'WCDB_CT_nick_name']),
          alias: this.pickStringField(row, ['alias', 'WCDB_CT_alias']),
          username: this.pickStringField(row, ['username', 'WCDB_CT_username']),
          userName: this.pickStringField(row, ['user_name', 'userName', 'WCDB_CT_user_name']),
          encryptUsername: this.pickStringField(row, ['encrypt_username', 'encryptUsername', 'WCDB_CT_encrypt_username']),
          encryptUserName: this.pickStringField(row, ['encrypt_user_name', 'encryptUserName', 'WCDB_CT_encrypt_user_name']),
          localType: this.pickIntegerField(row, ['local_type', 'localType', 'WCDB_CT_local_type'], 0)
        }
        const lookupKeys = this.buildIdCandidates([
          contact.username,
          contact.userName,
          contact.encryptUsername,
          contact.encryptUserName,
          contact.alias
        ])
        for (const key of lookupKeys) {
          const normalized = key.toLowerCase()
          if (!lookup.has(normalized)) {
            lookup.set(normalized, contact)
          }
        }
      }
    }

    const batchSize = 200
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize)
      if (batch.length === 0) continue

      const result = await wcdbService.getContactsCompact(batch)
      if (!result.success || !result.contacts) continue
      appendContactsToLookup(result.contacts as Record<string, unknown>[])
    }
    return lookup
  }

  private resolveContactByCandidates(
    lookup: Map<string, GroupMemberContactInfo>,
    candidates: Array<string | undefined | null>
  ): GroupMemberContactInfo | undefined {
    const ids = this.buildIdCandidates(candidates)
    for (const id of ids) {
      const hit = lookup.get(id.toLowerCase())
      if (hit) return hit
    }
    return undefined
  }

  private async buildGroupMessageCountLookup(chatroomId: string): Promise<Map<string, number>> {
    const lookup = new Map<string, number>()
    const result = await wcdbService.getGroupStats(chatroomId, 0, 0)
    if (!result.success || !result.data) return lookup

    const sessionData = result.data?.sessions?.[chatroomId]
    if (!sessionData || !sessionData.senders) return lookup

    const idMap = result.data.idMap || {}
    for (const [senderId, rawCount] of Object.entries(sessionData.senders as Record<string, number>)) {
      const username = String(idMap[senderId] || senderId || '').trim()
      if (!username) continue
      const count = this.toNonNegativeInteger(rawCount)
      const keys = this.buildIdCandidates([username])
      for (const key of keys) {
        const normalized = key.toLowerCase()
        const prev = lookup.get(normalized) || 0
        if (count > prev) {
          lookup.set(normalized, count)
        }
      }
    }
    return lookup
  }

  private resolveMessageCountByCandidates(
    lookup: Map<string, number>,
    candidates: Array<string | undefined | null>
  ): number {
    let maxCount = 0
    const ids = this.buildIdCandidates(candidates)
    for (const id of ids) {
      const count = lookup.get(id.toLowerCase())
      if (typeof count === 'number' && count > maxCount) {
        maxCount = count
      }
    }
    return maxCount
  }

  private isFriendMember(wxid: string, contact?: GroupMemberContactInfo): boolean {
    const normalizedWxid = String(wxid || '').trim().toLowerCase()
    if (!normalizedWxid) return false
    if (normalizedWxid.includes('@chatroom') || normalizedWxid.startsWith('gh_')) return false
    if (this.friendExcludeNames.has(normalizedWxid)) return false
    if (!contact) return false
    return contact.localType === 1
  }

  private sortGroupMembersPanelEntries(members: GroupMembersPanelEntry[]): GroupMembersPanelEntry[] {
    return members.sort((a, b) => {
      const ownerDiff = Number(Boolean(b.isOwner)) - Number(Boolean(a.isOwner))
      if (ownerDiff !== 0) return ownerDiff

      const friendDiff = Number(Boolean(b.isFriend)) - Number(Boolean(a.isFriend))
      if (friendDiff !== 0) return friendDiff

      if (a.messageCount !== b.messageCount) return b.messageCount - a.messageCount
      return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')
    })
  }

  private resolveGroupNicknameByCandidates(groupNicknames: Map<string, string>, candidates: string[]): string {
    const idCandidates = this.buildGroupNicknameIdCandidates(candidates)
    if (idCandidates.length === 0) return ''

    let resolved = ''
    for (const id of idCandidates) {
      const normalizedId = this.normalizeGroupNicknameIdentity(id)
      if (!normalizedId) continue
      const candidateNickname = this.normalizeGroupNickname(groupNicknames.get(normalizedId) || '')
      if (!candidateNickname) continue
      if (!resolved) {
        resolved = candidateNickname
        continue
      }
      if (resolved !== candidateNickname) return ''
    }

    return resolved
  }

  private sanitizeWorksheetName(name: string): string {
    const cleaned = (name || '').replace(/[*?:\\/\\[\\]]/g, '_').trim()
    const limited = cleaned.slice(0, 31)
    return limited || 'Sheet1'
  }

  private formatDateTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    const year = date.getFullYear()
    const month = pad(date.getMonth() + 1)
    const day = pad(date.getDate())
    const hour = pad(date.getHours())
    const minute = pad(date.getMinutes())
    const second = pad(date.getSeconds())
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`
  }

  private formatUnixTime(createTime: number): string {
    if (!Number.isFinite(createTime) || createTime <= 0) return ''
    const milliseconds = createTime > 1e12 ? createTime : createTime * 1000
    const date = new Date(milliseconds)
    if (Number.isNaN(date.getTime())) return String(createTime)
    return this.formatDateTime(date)
  }

  private getSimpleMessageTypeName(localType: number): string {
    const typeMap: Record<number, string> = {
      1: '文本',
      3: '图片',
      34: '语音',
      42: '名片',
      43: '视频',
      47: '表情',
      48: '位置',
      49: '链接/文件',
      50: '通话',
      10000: '系统',
      266287972401: '拍一拍',
      8594229559345: '红包',
      8589934592049: '转账'
    }
    return typeMap[localType] || `类型(${localType})`
  }

  private normalizeIdCandidates(values: Array<string | null | undefined>): string[] {
    return this.buildIdCandidates(values).map(value => value.toLowerCase())
  }

  private isSameAccountIdentity(left: string | null | undefined, right: string | null | undefined): boolean {
    const leftCandidates = this.normalizeIdCandidates([left])
    const rightCandidates = this.normalizeIdCandidates([right])
    if (leftCandidates.length === 0 || rightCandidates.length === 0) return false

    const rightSet = new Set(rightCandidates)
    for (const leftCandidate of leftCandidates) {
      if (rightSet.has(leftCandidate)) return true
      for (const rightCandidate of rightCandidates) {
        if (leftCandidate.startsWith(`${rightCandidate}_`) || rightCandidate.startsWith(`${leftCandidate}_`)) {
          return true
        }
      }
    }
    return false
  }

  private resolveExportMessageContent(message: Message): string {
    const parsed = String(message.parsedContent || '').trim()
    if (parsed) return parsed
    const raw = String(message.rawContent || '').trim()
    if (raw) return raw
    return ''
  }

  private normalizeCursorTimestamp(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0
    const normalized = Math.floor(value)
    return normalized > 10000000000 ? Math.floor(normalized / 1000) : normalized
  }

  private extractRowSenderUsername(row: Record<string, any>, myWxid?: string): string {
    const isSendRaw = row.computed_is_send ?? row.is_send ?? row.isSend ?? row.WCDB_CT_is_send
    if (isSendRaw != null && parseInt(isSendRaw, 10) === 1 && myWxid) {
      return myWxid
    }

    const candidates = [
      row.sender_username,
      row.senderUsername,
      row.sender,
      row.WCDB_CT_sender_username
    ]
    for (const candidate of candidates) {
      const value = String(candidate || '').trim()
      if (value) return value
    }
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.toLowerCase()
      if (
        normalizedKey === 'sender_username' ||
        normalizedKey === 'senderusername' ||
        normalizedKey === 'sender' ||
        normalizedKey === 'wcdb_ct_sender_username'
      ) {
        const normalizedValue = String(value || '').trim()
        if (normalizedValue) return normalizedValue
      }
    }
    
    // Fallback: fast extract from raw content to avoid full parse
    const rawContent = String(row.StrContent || row.message_content || row.content || row.msg_content || '').trim()
    if (rawContent) {
      const match = /^\s*([a-zA-Z0-9_@-]{4,}):(?!\/\/)\s*(?:\r?\n|<br\s*\/?>)/i.exec(rawContent)
      if (match && match[1]) {
        return match[1].trim()
      }
    }
    
    return ''
  }

  private parseSingleMessageRow(row: Record<string, any>): Message | null {
    try {
      const mapped = chatService.mapRowsToMessagesForApi([row])
      if (Array.isArray(mapped) && mapped.length > 0) {
        const msg = mapped[0]
        if (!msg.localType) {
          msg.localType = parseInt(row.Type || row.type || row.local_type || row.msg_type || '0', 10)
        }
        if (!msg.createTime) {
          msg.createTime = parseInt(row.CreateTime || row.create_time || row.createTime || row.msg_time || '0', 10)
        }
        return msg
      }
      return null
    } catch {
      return null
    }
  }

  private async openMemberMessageCursor(
    chatroomId: string,
    batchSize: number,
    ascending: boolean,
    startTime: number,
    endTime: number
  ): Promise<{ success: boolean; cursor?: number; error?: string }> {
    const beginTimestamp = this.normalizeCursorTimestamp(startTime)
    const endTimestamp = this.normalizeCursorTimestamp(endTime)
    const liteResult = await wcdbService.openMessageCursorLite(chatroomId, batchSize, ascending, beginTimestamp, endTimestamp)
    if (liteResult.success && liteResult.cursor) return liteResult
    return wcdbService.openMessageCursor(chatroomId, batchSize, ascending, beginTimestamp, endTimestamp)
  }

  private async collectMessagesByMember(
    chatroomId: string,
    memberUsername: string,
    startTime: number,
    endTime: number
  ): Promise<{ success: boolean; data?: Message[]; error?: string }> {
    const batchSize = 800
    const matchedMessages: Message[] = []
    const senderMatchCache = new Map<string, boolean>()
    const matchesTargetSender = (sender: string | null | undefined): boolean => {
      const key = String(sender || '').trim().toLowerCase()
      if (!key) return false
      const cached = senderMatchCache.get(key)
      if (typeof cached === 'boolean') return cached
      const matched = this.isSameAccountIdentity(memberUsername, sender)
      senderMatchCache.set(key, matched)
      return matched
    }

    const cursorResult = await this.openMemberMessageCursor(chatroomId, batchSize, true, startTime, endTime)
    if (!cursorResult.success || !cursorResult.cursor) {
      return { success: false, error: cursorResult.error || '创建群消息游标失败' }
    }

    const cursor = cursorResult.cursor
    try {
      while (true) {
        const batch = await wcdbService.fetchMessageBatch(cursor)
        if (!batch.success) {
          return { success: false, error: batch.error || '获取群消息失败' }
        }
        const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        if (rows.length === 0) break

        for (const row of rows) {
          const senderFromRow = this.extractRowSenderUsername(row, String(this.configService.get('myWxid') || '').trim())
          if (senderFromRow && !matchesTargetSender(senderFromRow)) {
            continue
          }
          const message = this.parseSingleMessageRow(row)
          if (!message) continue
          if (matchesTargetSender(message.senderUsername)) {
            matchedMessages.push(message)
          }
        }

        if (!batch.hasMore) break
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor)
    }

    return { success: true, data: matchedMessages }
  }

  async getGroupMemberMessages(
    chatroomId: string,
    memberUsername: string,
    options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }
  ): Promise<{ success: boolean; data?: GroupMemberMessagesPage; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const normalizedChatroomId = String(chatroomId || '').trim()
      const normalizedMemberUsername = String(memberUsername || '').trim()
      if (!normalizedChatroomId) return { success: false, error: '群聊ID不能为空' }
      if (!normalizedMemberUsername) return { success: false, error: '成员ID不能为空' }

      const startTimeValue = Number.isFinite(options?.startTime) && typeof options?.startTime === 'number'
        ? Math.max(0, Math.floor(options.startTime))
        : 0
      const endTimeValue = Number.isFinite(options?.endTime) && typeof options?.endTime === 'number'
        ? Math.max(0, Math.floor(options.endTime))
        : 0
      const limit = Number.isFinite(options?.limit) && typeof options?.limit === 'number'
        ? Math.max(1, Math.min(100, Math.floor(options.limit)))
        : 50
      let cursor = Number.isFinite(options?.cursor) && typeof options?.cursor === 'number'
        ? Math.max(0, Math.floor(options.cursor))
        : 0

      const matchedMessages: Message[] = []
      const senderMatchCache = new Map<string, boolean>()
      const matchesTargetSender = (sender: string | null | undefined): boolean => {
        const key = String(sender || '').trim().toLowerCase()
        if (!key) return false
        const cached = senderMatchCache.get(key)
        if (typeof cached === 'boolean') return cached
        const matched = this.isSameAccountIdentity(normalizedMemberUsername, sender)
        senderMatchCache.set(key, matched)
        return matched
      }
      const batchSize = Math.max(limit * 4, 240)
      let hasMore = false

      const cursorResult = await this.openMemberMessageCursor(
        normalizedChatroomId,
        batchSize,
        false,
        startTimeValue,
        endTimeValue
      )
      if (!cursorResult.success || !cursorResult.cursor) {
        return { success: false, error: cursorResult.error || '创建群成员消息游标失败' }
      }

      let consumedRows = 0
      const dbCursor = cursorResult.cursor

      try {
        while (matchedMessages.length < limit) {
          const batch = await wcdbService.fetchMessageBatch(dbCursor)
          if (!batch.success) {
            return { success: false, error: batch.error || '获取群成员消息失败' }
          }

          const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
          if (rows.length === 0) {
            hasMore = false
            break
          }

          let startIndex = 0
          if (cursor > consumedRows) {
            const skipCount = Math.min(cursor - consumedRows, rows.length)
            consumedRows += skipCount
            startIndex = skipCount
            if (startIndex >= rows.length) {
              if (!batch.hasMore) {
                hasMore = false
                break
              }
              continue
            }
          }

          for (let index = startIndex; index < rows.length; index += 1) {
            const row = rows[index]
            consumedRows += 1

            const senderFromRow = this.extractRowSenderUsername(row, String(this.configService.get('myWxid') || '').trim())
            if (senderFromRow && !matchesTargetSender(senderFromRow)) {
              continue
            }

            const message = this.parseSingleMessageRow(row)
            if (!message) continue
            if (!matchesTargetSender(message.senderUsername)) {
              continue
            }

            matchedMessages.push(message)
            if (matchedMessages.length >= limit) {
              cursor = consumedRows
              hasMore = index < rows.length - 1 || batch.hasMore === true
              break
            }
          }

          if (matchedMessages.length >= limit) break

          cursor = consumedRows
          if (!batch.hasMore) {
            hasMore = false
            break
          }
        }
      } finally {
        await wcdbService.closeMessageCursor(dbCursor)
      }

      return {
        success: true,
        data: {
          messages: matchedMessages,
          hasMore,
          nextCursor: cursor
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupChats(): Promise<{ success: boolean; data?: GroupChatInfo[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const sessionResult = await wcdbService.getSessions()
      if (!sessionResult.success || !sessionResult.sessions) {
        return { success: false, error: sessionResult.error || '获取会话失败' }
      }

      const rows = sessionResult.sessions as Record<string, any>[]
      const groupIds = rows
        .map((row) => row.username || row.user_name || row.userName || '')
        .filter((username) => username.includes('@chatroom'))

      const [memberCounts, contactInfo] = await Promise.all([
        wcdbService.getGroupMemberCounts(groupIds),
        chatService.enrichSessionsContactInfo(groupIds)
      ])

      let fallbackNames: { success: boolean; map?: Record<string, string> } | null = null
      let fallbackAvatars: { success: boolean; map?: Record<string, string> } | null = null
      if (!contactInfo.success || !contactInfo.contacts) {
        const [displayNames, avatarUrls] = await Promise.all([
          wcdbService.getDisplayNames(groupIds),
          wcdbService.getAvatarUrls(groupIds)
        ])
        fallbackNames = displayNames
        fallbackAvatars = avatarUrls
      }

      const groups: GroupChatInfo[] = []
      for (const groupId of groupIds) {
        const contact = contactInfo.success && contactInfo.contacts ? contactInfo.contacts[groupId] : undefined
        const displayName = contact?.displayName ||
          (fallbackNames && fallbackNames.success && fallbackNames.map ? (fallbackNames.map[groupId] || '') : '') ||
          groupId
        const avatarUrl = contact?.avatarUrl ||
          (fallbackAvatars && fallbackAvatars.success && fallbackAvatars.map ? fallbackAvatars.map[groupId] : undefined)

        groups.push({
          username: groupId,
          displayName,
          memberCount: memberCounts.success && memberCounts.map && typeof memberCounts.map[groupId] === 'number'
            ? memberCounts.map[groupId]
            : 0,
          avatarUrl
        })
      }

      groups.sort((a, b) => b.memberCount - a.memberCount)
      return { success: true, data: groups }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async loadGroupMembersPanelDataFresh(
    chatroomId: string,
    includeMessageCounts: boolean
  ): Promise<{ success: boolean; data?: GroupMembersPanelEntry[]; error?: string }> {
    const membersResult = await wcdbService.getGroupMembers(chatroomId)
    if (!membersResult.success || !membersResult.members) {
      return { success: false, error: membersResult.error || '获取群成员失败' }
    }

    const members = membersResult.members as Array<{
      username: string
      avatarUrl?: string
      originalName?: string
      [key: string]: unknown
    }>
    if (members.length === 0) return { success: true, data: [] }

    const usernames = members
      .map((member) => String(member.username || '').trim())
      .filter(Boolean)
    if (usernames.length === 0) return { success: true, data: [] }

    const displayNamesPromise = wcdbService.getDisplayNames(usernames)
    const contactLookupPromise = this.buildGroupMemberContactLookup(usernames)
    const ownerPromise = this.detectGroupOwnerUsername(chatroomId, members)
    const messageCountLookupPromise = includeMessageCounts
      ? this.buildGroupMessageCountLookup(chatroomId)
      : Promise.resolve(new Map<string, number>())

    const [displayNames, contactLookup, ownerUsername, messageCountLookup] = await Promise.all([
      displayNamesPromise,
      contactLookupPromise,
      ownerPromise,
      messageCountLookupPromise
    ])

    const nicknameCandidates = this.buildIdCandidates([
      ...members.map((member) => member.username),
      ...members.map((member) => member.originalName),
      ...Array.from(contactLookup.values()).map((contact) => contact?.username),
      ...Array.from(contactLookup.values()).map((contact) => contact?.userName),
      ...Array.from(contactLookup.values()).map((contact) => contact?.encryptUsername),
      ...Array.from(contactLookup.values()).map((contact) => contact?.encryptUserName),
      ...Array.from(contactLookup.values()).map((contact) => contact?.alias)
    ])
    const groupNicknames = await this.getGroupNicknamesForRoom(chatroomId, nicknameCandidates)
    const myWxid = this.cleanAccountDirName(this.configService.get('myWxid') || '')
    let myGroupMessageCountHint: number | undefined

    const data: GroupMembersPanelEntry[] = members
      .map((member) => {
        const wxid = String(member.username || '').trim()
        if (!wxid) return null

        const contact = this.resolveContactByCandidates(contactLookup, [wxid, member.originalName])
        const nickname = contact?.nickName || ''
        const remark = contact?.remark || ''
        const alias = contact?.alias || ''
        const normalizedWxid = this.cleanAccountDirName(wxid)
        const lookupCandidates = this.buildIdCandidates([
          wxid,
          member.originalName as string | undefined,
          contact?.username,
          contact?.userName,
          contact?.encryptUsername,
          contact?.encryptUserName,
          alias
        ])
        if (normalizedWxid === myWxid) {
          lookupCandidates.push(myWxid)
        }
        const groupNickname = this.resolveGroupNicknameByCandidates(groupNicknames, lookupCandidates)
        const displayName = displayNames.success && displayNames.map ? (displayNames.map[wxid] || wxid) : wxid

        return {
          username: wxid,
          displayName,
          nickname,
          alias,
          remark,
          groupNickname,
          avatarUrl: member.avatarUrl,
          isOwner: Boolean(ownerUsername && ownerUsername === wxid),
          isFriend: this.isFriendMember(wxid, contact),
          messageCount: this.resolveMessageCountByCandidates(messageCountLookup, lookupCandidates)
        }
      })
      .filter((member): member is GroupMembersPanelEntry => Boolean(member))

    if (includeMessageCounts && myWxid) {
      const selfEntry = data.find((member) => this.cleanAccountDirName(member.username) === myWxid)
      if (selfEntry && Number.isFinite(selfEntry.messageCount)) {
        myGroupMessageCountHint = Math.max(0, Math.floor(selfEntry.messageCount))
      }
    }

    if (includeMessageCounts && Number.isFinite(myGroupMessageCountHint)) {
      void chatService.setGroupMyMessageCountHint(chatroomId, myGroupMessageCountHint as number)
    }

    return { success: true, data: this.sortGroupMembersPanelEntries(data) }
  }

  async getGroupMembersPanelData(
    chatroomId: string,
    options?: { forceRefresh?: boolean; includeMessageCounts?: boolean }
  ): Promise<{ success: boolean; data?: GroupMembersPanelEntry[]; error?: string; fromCache?: boolean; updatedAt?: number }> {
    try {
      const normalizedChatroomId = String(chatroomId || '').trim()
      if (!normalizedChatroomId) return { success: false, error: '群聊ID不能为空' }

      const forceRefresh = Boolean(options?.forceRefresh)
      const includeMessageCounts = options?.includeMessageCounts !== false
      const cacheKey = this.buildGroupMembersPanelCacheKey(normalizedChatroomId, includeMessageCounts)
      const now = Date.now()
      const cached = this.groupMembersPanelCache.get(cacheKey)
      if (!forceRefresh && cached && now - cached.updatedAt < this.groupMembersPanelCacheTtlMs) {
        return { success: true, data: cached.data, fromCache: true, updatedAt: cached.updatedAt }
      }

      if (!forceRefresh) {
        const pending = this.groupMembersPanelInFlight.get(cacheKey)
        if (pending) return pending
      }

      const requestPromise = (async () => {
        const conn = await this.ensureConnected()
        if (!conn.success) return { success: false, error: conn.error }

        const timeoutMs = includeMessageCounts
          ? this.groupMembersPanelFullTimeoutMs
          : this.groupMembersPanelMembersTimeoutMs
        const fresh = await this.withPromiseTimeout(
          this.loadGroupMembersPanelDataFresh(normalizedChatroomId, includeMessageCounts),
          timeoutMs,
          {
            success: false,
            error: includeMessageCounts
              ? '群成员发言统计加载超时，请稍后重试'
              : '群成员列表加载超时，请稍后重试'
          }
        )
        if (!fresh.success || !fresh.data) {
          return { success: false, error: fresh.error || '获取群成员面板数据失败' }
        }

        const updatedAt = Date.now()
        this.groupMembersPanelCache.set(cacheKey, { updatedAt, data: fresh.data })
        this.pruneGroupMembersPanelCache()
        return { success: true, data: fresh.data, fromCache: false, updatedAt }
      })().finally(() => {
        this.groupMembersPanelInFlight.delete(cacheKey)
      })

      this.groupMembersPanelInFlight.set(cacheKey, requestPromise)
      return await requestPromise
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMembers(chatroomId: string): Promise<{ success: boolean; data?: GroupMember[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupMembers(chatroomId)
      if (!result.success || !result.members) {
        return { success: false, error: result.error || '获取群成员失败' }
      }

      const members = result.members as Array<{
        username: string
        avatarUrl?: string
        originalName?: string
        [key: string]: unknown
      }>
      const usernames = members.map((m) => m.username).filter(Boolean)

      const displayNamesPromise = wcdbService.getDisplayNames(usernames)

      const contactMap = new Map<string, {
        remark?: string
        nickName?: string
        alias?: string
        username?: string
        userName?: string
        encryptUsername?: string
        encryptUserName?: string
      }>()
      const concurrency = 6
      await this.parallelLimit(usernames, concurrency, async (username) => {
        const contactResult = await wcdbService.getContact(username)
        if (contactResult.success && contactResult.contact) {
          const contact = contactResult.contact as any
          contactMap.set(username, {
            remark: contact.remark || '',
            nickName: contact.nickName || contact.nick_name || '',
            alias: contact.alias || '',
            username: contact.username || '',
            userName: contact.userName || contact.user_name || '',
            encryptUsername: contact.encryptUsername || contact.encrypt_username || '',
            encryptUserName: contact.encryptUserName || ''
          })
        } else {
          contactMap.set(username, { remark: '', nickName: '', alias: '' })
        }
      })

      const displayNames = await displayNamesPromise
      const nicknameCandidates = this.buildIdCandidates([
        ...members.map((m) => m.username),
        ...members.map((m) => m.originalName),
        ...Array.from(contactMap.values()).map((c) => c?.username),
        ...Array.from(contactMap.values()).map((c) => c?.userName),
        ...Array.from(contactMap.values()).map((c) => c?.encryptUsername),
        ...Array.from(contactMap.values()).map((c) => c?.encryptUserName),
        ...Array.from(contactMap.values()).map((c) => c?.alias)
      ])
      const groupNicknames = await this.getGroupNicknamesForRoom(chatroomId, nicknameCandidates)

      const myWxid = this.cleanAccountDirName(this.configService.get('myWxid') || '')
      const ownerUsername = await this.detectGroupOwnerUsername(chatroomId, members)
      const data: GroupMember[] = members.map((m) => {
        const wxid = m.username || ''
        const displayName = displayNames.success && displayNames.map ? (displayNames.map[wxid] || wxid) : wxid
        const contact = contactMap.get(wxid)
        const nickname = contact?.nickName || ''
        const remark = contact?.remark || ''
        const alias = contact?.alias || ''
        const normalizedWxid = this.cleanAccountDirName(wxid)
        const lookupCandidates = this.buildIdCandidates([
          wxid,
          m.originalName,
          contact?.username,
          contact?.userName,
          contact?.encryptUsername,
          contact?.encryptUserName,
          alias
        ])
        if (normalizedWxid === myWxid) {
          lookupCandidates.push(myWxid)
        }
        const groupNickname = this.resolveGroupNicknameByCandidates(groupNicknames, lookupCandidates)

        return {
          username: wxid,
          displayName,
          nickname,
          alias,
          remark,
          groupNickname,
          avatarUrl: m.avatarUrl,
          isOwner: Boolean(ownerUsername && ownerUsername === wxid)
        }
      })

      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMessageRanking(chatroomId: string, limit: number = 20, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupMessageRank[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const d = result.data
      const sessionData = d.sessions[chatroomId]
      if (!sessionData || !sessionData.senders) return { success: true, data: [] }

      const idMap = d.idMap || {}
      const senderEntries = Object.entries(sessionData.senders as Record<string, number>)

      const rankings: GroupMessageRank[] = senderEntries
        .map(([id, count]) => {
          const username = idMap[id] || id
          return {
            member: { username, displayName: username }, // Display name will be resolved below
            messageCount: count
          }
        })
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, limit)

      // 批量获取显示名称和头像
      const usernames = rankings.map(r => r.member.username)
      const [names, avatars] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames)
      ])

      for (const rank of rankings) {
        if (names.success && names.map && names.map[rank.member.username]) {
          rank.member.displayName = names.map[rank.member.username]
        }
        if (avatars.success && avatars.map && avatars.map[rank.member.username]) {
          rank.member.avatarUrl = avatars.map[rank.member.username]
        }
      }

      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }



  async getGroupActiveHours(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupActiveHours; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const hourlyDistribution: Record<number, number> = {}
      for (let i = 0; i < 24; i++) {
        hourlyDistribution[i] = result.data.hourly[i] || 0
      }

      return { success: true, data: { hourlyDistribution } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMediaStats(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupMediaStats; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const typeCountsRaw = result.data.typeCounts as Record<string, number>
      const mainTypes = [1, 3, 34, 43, 47, 49]
      const typeNames: Record<number, string> = {
        1: '文本', 3: '图片', 34: '语音', 43: '视频', 47: '表情包', 49: '链接/文件'
      }

      const countsMap = new Map<number, number>()
      let othersCount = 0

      for (const [typeStr, count] of Object.entries(typeCountsRaw)) {
        const type = parseInt(typeStr, 10)
        if (mainTypes.includes(type)) {
          countsMap.set(type, (countsMap.get(type) || 0) + count)
        } else {
          othersCount += count
        }
      }

      const mediaCounts: MediaTypeCount[] = mainTypes
        .map(type => ({
          type,
          name: typeNames[type],
          count: countsMap.get(type) || 0
        }))
        .filter(item => item.count > 0)

      if (othersCount > 0) {
        mediaCounts.push({ type: -1, name: '其他', count: othersCount })
      }

      mediaCounts.sort((a, b) => b.count - a.count)
      const total = mediaCounts.reduce((sum, item) => sum + item.count, 0)

      return { success: true, data: { typeCounts: mediaCounts, total } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMemberAnalytics(
    chatroomId: string,
    memberUsername: string,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; data?: GroupMemberAnalytics; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const normalizedChatroomId = String(chatroomId || '').trim()
      const normalizedMemberUsername = String(memberUsername || '').trim()

      const batchSize = 10000
      const senderMatchCache = new Map<string, boolean>()
      const matchesTargetSender = (sender: string | null | undefined): boolean => {
        const key = String(sender || '').trim().toLowerCase()
        if (!key) return false
        const cached = senderMatchCache.get(key)
        if (typeof cached === 'boolean') return cached
        const matched = this.isSameAccountIdentity(normalizedMemberUsername, sender)
        senderMatchCache.set(key, matched)
        return matched
      }

      const cursorResult = await this.openMemberMessageCursor(normalizedChatroomId, batchSize, true, startTime || 0, endTime || 0)
      if (!cursorResult.success || !cursorResult.cursor) {
        return { success: false, error: cursorResult.error || '创建游标失败' }
      }

      const cursor = cursorResult.cursor
      const stats: ChatStatistics = {
        totalMessages: 0,
        textMessages: 0,
        imageMessages: 0,
        voiceMessages: 0,
        videoMessages: 0,
        emojiMessages: 0,
        otherMessages: 0,
        sentMessages: 0, // In group, we only fetch messages of this member, so sentMessages = totalMessages
        receivedMessages: 0, // No meaning here
        firstMessageTime: null,
        lastMessageTime: null,
        activeDays: 0,
        messageTypeCounts: {}
      }
      
      const hourlyDistribution: Record<number, number> = {}
      for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0
      const dailySet = new Set<string>()
      const textTypes = [1, 244813135921]

      const phraseCounts = new Map<string, number>()
      const emojiCounts = new Map<string, number>()

      const myWxid = String(this.configService.get('myWxid') || '').trim()

      try {
        while (true) {
          const batch = await wcdbService.fetchMessageBatch(cursor)
          if (!batch.success) {
            return { success: false, error: batch.error || '获取分析数据失败' }
          }
          const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
          if (rows.length === 0) break

          for (const row of rows) {
            let senderFromRow = this.extractRowSenderUsername(row, myWxid)
            
            const isSendRaw = row.computed_is_send ?? row.is_send ?? row.isSend ?? row.WCDB_CT_is_send
            const isSend = isSendRaw != null ? parseInt(isSendRaw, 10) === 1 : false
            
            if (isSend) {
              senderFromRow = myWxid
            }

            if (!senderFromRow || !matchesTargetSender(senderFromRow)) {
              continue
            }
            
            const msgType = parseInt(row.Type || row.type || row.local_type || row.msg_type || '0', 10)
            const createTime = parseInt(row.CreateTime || row.create_time || row.createTime || row.msg_time || '0', 10)
            
            let content = String(row.StrContent || row.message_content || row.content || row.msg_content || '')
            if (content) {
              content = content.replace(/^\s*([a-zA-Z0-9_@-]{4,}):(?!\/\/)\s*(?:\r?\n|<br\s*\/?>)/i, '')
            }

            stats.totalMessages++
            if (textTypes.includes(msgType)) {
              stats.textMessages++
              if (content) {
                const text = content.trim()
                if (text && text.length <= 20) {
                  phraseCounts.set(text, (phraseCounts.get(text) || 0) + 1)
                }
                const emojiMatches = text.match(/\[.*?\]/g)
                if (emojiMatches) {
                  for (const em of emojiMatches) {
                    emojiCounts.set(em, (emojiCounts.get(em) || 0) + 1)
                  }
                }
              }
            }
            else if (msgType === 3) stats.imageMessages++
            else if (msgType === 34) stats.voiceMessages++
            else if (msgType === 43) stats.videoMessages++
            else if (msgType === 47) stats.emojiMessages++
            else stats.otherMessages++

            stats.sentMessages++
            
            stats.messageTypeCounts[msgType] = (stats.messageTypeCounts[msgType] || 0) + 1
            
            if (createTime > 0) {
              if (stats.firstMessageTime === null || createTime < stats.firstMessageTime) stats.firstMessageTime = createTime
              if (stats.lastMessageTime === null || createTime > stats.lastMessageTime) stats.lastMessageTime = createTime
              
              const d = new Date(createTime * 1000)
              const hour = d.getHours()
              hourlyDistribution[hour]++
              dailySet.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)
            }
          }
          if (!batch.hasMore) break
        }
      } finally {
        await wcdbService.closeMessageCursor(cursor)
      }
      
      stats.activeDays = dailySet.size

      const commonPhrases = Array.from(phraseCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([phrase, count]) => ({ phrase, count }))
        
      const commonEmojis = Array.from(emojiCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([emoji, count]) => ({ emoji, count }))

      return { success: true, data: { statistics: stats, timeDistribution: hourlyDistribution, commonPhrases, commonEmojis } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async exportGroupMemberMessages(
    chatroomId: string,
    memberUsername: string,
    outputPath: string,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; count?: number; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const normalizedChatroomId = String(chatroomId || '').trim()
      const normalizedMemberUsername = String(memberUsername || '').trim()
      if (!normalizedChatroomId) return { success: false, error: '群聊ID不能为空' }
      if (!normalizedMemberUsername) return { success: false, error: '成员ID不能为空' }

      const beginTimestamp = Number.isFinite(startTime) && typeof startTime === 'number'
        ? Math.max(0, Math.floor(startTime))
        : 0
      const endTimestampValue = Number.isFinite(endTime) && typeof endTime === 'number'
        ? Math.max(0, Math.floor(endTime))
        : 0

      const exportDate = new Date()
      const exportTime = this.formatDateTime(exportDate)
      const exportVersion = '0.0.2'
      const exportGenerator = 'WeFlow'
      const exportPlatform = 'wechat'

      const groupDisplay = await wcdbService.getDisplayNames([normalizedChatroomId, normalizedMemberUsername])
      const groupName = groupDisplay.success && groupDisplay.map
        ? (groupDisplay.map[normalizedChatroomId] || normalizedChatroomId)
        : normalizedChatroomId
      const defaultMemberDisplayName = groupDisplay.success && groupDisplay.map
        ? (groupDisplay.map[normalizedMemberUsername] || normalizedMemberUsername)
        : normalizedMemberUsername

      let memberDisplayName = defaultMemberDisplayName
      let memberAlias = ''
      let memberRemark = ''
      let memberGroupNickname = ''
      const membersResult = await this.getGroupMembers(normalizedChatroomId)
      if (membersResult.success && membersResult.data) {
        const matchedMember = membersResult.data.find((item) =>
          this.isSameAccountIdentity(item.username, normalizedMemberUsername)
        )
        if (matchedMember) {
          memberDisplayName = matchedMember.displayName || defaultMemberDisplayName
          memberAlias = matchedMember.alias || ''
          memberRemark = matchedMember.remark || ''
          memberGroupNickname = matchedMember.groupNickname || ''
        }
      }

      const collected = await this.collectMessagesByMember(
        normalizedChatroomId,
        normalizedMemberUsername,
        beginTimestamp,
        endTimestampValue
      )
      if (!collected.success || !collected.data) {
        return { success: false, error: collected.error || '获取成员消息失败' }
      }

      const records = collected.data.map((message, index) => ({
        index: index + 1,
        time: this.formatUnixTime(message.createTime),
        sender: message.senderUsername || '',
        messageType: this.getSimpleMessageTypeName(message.localType),
        content: this.resolveExportMessageContent(message)
      }))

      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      const ext = path.extname(outputPath).toLowerCase()
      if (ext === '.csv') {
        const infoTitleRow = ['会话信息']
        const infoRow = ['群聊ID', normalizedChatroomId, '', '群聊名称', groupName, '成员wxid', normalizedMemberUsername, '']
        const memberRow = ['成员显示名', memberDisplayName, '成员备注', memberRemark, '群昵称', memberGroupNickname, '微信号', memberAlias]
        const metaRow = ['导出工具', exportGenerator, '导出版本', exportVersion, '平台', exportPlatform, '导出时间', exportTime]
        const header = ['序号', '时间', '发送者wxid', '消息类型', '内容']

        const csvRows: string[][] = [infoTitleRow, infoRow, memberRow, metaRow, header]
        for (const record of records) {
          csvRows.push([String(record.index), record.time, record.sender, record.messageType, record.content])
        }

        const csvLines = csvRows.map((row) => row.map((cell) => this.escapeCsvValue(cell)).join(','))
        const content = '\ufeff' + csvLines.join('\n')
        fs.writeFileSync(outputPath, content, 'utf8')
      } else {
        const workbook = new ExcelJS.Workbook()
        const worksheet = workbook.addWorksheet(this.sanitizeWorksheetName('成员消息记录'))

        worksheet.getCell(1, 1).value = '会话信息'
        worksheet.getCell(1, 1).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getRow(1).height = 24

        worksheet.getCell(2, 1).value = '群聊ID'
        worksheet.getCell(2, 1).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.mergeCells(2, 2, 2, 3)
        worksheet.getCell(2, 2).value = normalizedChatroomId

        worksheet.getCell(2, 4).value = '群聊名称'
        worksheet.getCell(2, 4).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(2, 5).value = groupName
        worksheet.getCell(2, 6).value = '成员wxid'
        worksheet.getCell(2, 6).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.mergeCells(2, 7, 2, 8)
        worksheet.getCell(2, 7).value = normalizedMemberUsername

        worksheet.getCell(3, 1).value = '成员显示名'
        worksheet.getCell(3, 1).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(3, 2).value = memberDisplayName
        worksheet.getCell(3, 3).value = '成员备注'
        worksheet.getCell(3, 3).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(3, 4).value = memberRemark
        worksheet.getCell(3, 5).value = '群昵称'
        worksheet.getCell(3, 5).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(3, 6).value = memberGroupNickname
        worksheet.getCell(3, 7).value = '微信号'
        worksheet.getCell(3, 7).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(3, 8).value = memberAlias

        worksheet.getCell(4, 1).value = '导出工具'
        worksheet.getCell(4, 1).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(4, 2).value = exportGenerator
        worksheet.getCell(4, 3).value = '导出版本'
        worksheet.getCell(4, 3).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(4, 4).value = exportVersion
        worksheet.getCell(4, 5).value = '平台'
        worksheet.getCell(4, 5).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(4, 6).value = exportPlatform
        worksheet.getCell(4, 7).value = '导出时间'
        worksheet.getCell(4, 7).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.getCell(4, 8).value = exportTime

        const headerRow = worksheet.getRow(5)
        const header = ['序号', '时间', '发送者wxid', '消息类型', '内容']
        header.forEach((title, index) => {
          const cell = headerRow.getCell(index + 1)
          cell.value = title
          cell.font = { name: 'Calibri', bold: true, size: 11 }
        })
        headerRow.height = 22

        worksheet.getColumn(1).width = 10
        worksheet.getColumn(2).width = 22
        worksheet.getColumn(3).width = 30
        worksheet.getColumn(4).width = 16
        worksheet.getColumn(5).width = 90
        worksheet.getColumn(6).width = 16
        worksheet.getColumn(7).width = 20
        worksheet.getColumn(8).width = 24

        let currentRow = 6
        for (const record of records) {
          const row = worksheet.getRow(currentRow)
          row.getCell(1).value = record.index
          row.getCell(2).value = record.time
          row.getCell(3).value = record.sender
          row.getCell(4).value = record.messageType
          row.getCell(5).value = record.content
          row.alignment = { vertical: 'top', wrapText: true }
          currentRow += 1
        }

        await workbook.xlsx.writeFile(outputPath)
      }

      return { success: true, count: records.length }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async exportGroupMembers(chatroomId: string, outputPath: string): Promise<{ success: boolean; count?: number; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const exportDate = new Date()
      const exportTime = this.formatDateTime(exportDate)
      const exportVersion = '0.0.2'
      const exportGenerator = 'WeFlow'
      const exportPlatform = 'wechat'

      const groupDisplay = await wcdbService.getDisplayNames([chatroomId])
      const groupName = groupDisplay.success && groupDisplay.map
        ? (groupDisplay.map[chatroomId] || chatroomId)
        : chatroomId

      const groupContact = await wcdbService.getContact(chatroomId)
      const sessionRemark = (groupContact.success && groupContact.contact)
        ? (groupContact.contact.remark || '')
        : ''

      const membersResult = await wcdbService.getGroupMembers(chatroomId)
      if (!membersResult.success || !membersResult.members) {
        return { success: false, error: membersResult.error || '获取群成员失败' }
      }

      const members = membersResult.members as Array<{
        username: string
        avatarUrl?: string
        originalName?: string
      }>
      if (members.length === 0) {
        return { success: false, error: '群成员为空' }
      }

      const usernames = members.map((m) => m.username).filter(Boolean)
      const displayNamesPromise = wcdbService.getDisplayNames(usernames)

      const contactMap = new Map<string, {
        remark?: string
        nickName?: string
        alias?: string
        username?: string
        userName?: string
        encryptUsername?: string
        encryptUserName?: string
      }>()
      const concurrency = 6
      await this.parallelLimit(usernames, concurrency, async (username) => {
        const result = await wcdbService.getContact(username)
        if (result.success && result.contact) {
          const contact = result.contact as any
          contactMap.set(username, {
            remark: contact.remark || '',
            nickName: contact.nickName || contact.nick_name || '',
            alias: contact.alias || '',
            username: contact.username || '',
            userName: contact.userName || contact.user_name || '',
            encryptUsername: contact.encryptUsername || contact.encrypt_username || '',
            encryptUserName: contact.encryptUserName || ''
          })
        } else {
          contactMap.set(username, { remark: '', nickName: '', alias: '' })
        }
      })

      const infoTitleRow = ['会话信息']
      const infoRow = ['微信ID', chatroomId, '', '昵称', groupName, '备注', sessionRemark || '', '']
      const metaRow = ['导出工具', exportGenerator, '导出版本', exportVersion, '平台', exportPlatform, '导出时间', exportTime]

      const header = ['微信昵称', '微信备注', '群昵称', 'wxid', '微信号']
      const rows: string[][] = [infoTitleRow, infoRow, metaRow, header]
      const myWxid = this.cleanAccountDirName(this.configService.get('myWxid') || '')

      const displayNames = await displayNamesPromise
      const nicknameCandidates = this.buildIdCandidates([
        ...members.map((m) => m.username),
        ...members.map((m) => m.originalName),
        ...Array.from(contactMap.values()).map((c) => c?.username),
        ...Array.from(contactMap.values()).map((c) => c?.userName),
        ...Array.from(contactMap.values()).map((c) => c?.encryptUsername),
        ...Array.from(contactMap.values()).map((c) => c?.encryptUserName),
        ...Array.from(contactMap.values()).map((c) => c?.alias)
      ])
      const groupNicknames = await this.getGroupNicknamesForRoom(chatroomId, nicknameCandidates)

      for (const member of members) {
        const wxid = member.username
        const normalizedWxid = this.cleanAccountDirName(wxid || '')
        const contact = contactMap.get(wxid)
        const fallbackName = displayNames.success && displayNames.map ? (displayNames.map[wxid] || '') : ''
        const nickName = contact?.nickName || fallbackName || ''
        const remark = contact?.remark || ''
        const alias = contact?.alias || ''
        const lookupCandidates = this.buildIdCandidates([
          wxid,
          member.originalName,
          contact?.username,
          contact?.userName,
          contact?.encryptUsername,
          contact?.encryptUserName,
          alias
        ])
        if (normalizedWxid === myWxid) {
          lookupCandidates.push(myWxid)
        }
        const groupNickname = this.resolveGroupNicknameByCandidates(groupNicknames, lookupCandidates)

        rows.push([nickName, remark, groupNickname, wxid, alias])
      }

      const ext = path.extname(outputPath).toLowerCase()
      if (ext === '.csv') {
        const csvLines = rows.map((row) => row.map((cell) => this.escapeCsvValue(cell)).join(','))
        const content = '\ufeff' + csvLines.join('\n')
        fs.writeFileSync(outputPath, content, 'utf8')
      } else {
        const workbook = new ExcelJS.Workbook()
        const sheet = workbook.addWorksheet(this.sanitizeWorksheetName('群成员列表'))

        let currentRow = 1
        const titleCell = sheet.getCell(currentRow, 1)
        titleCell.value = '会话信息'
        titleCell.font = { name: 'Calibri', bold: true, size: 11 }
        titleCell.alignment = { vertical: 'middle', horizontal: 'left' }
        sheet.getRow(currentRow).height = 25
        currentRow++

        sheet.getCell(currentRow, 1).value = '微信ID'
        sheet.getCell(currentRow, 1).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.mergeCells(currentRow, 2, currentRow, 3)
        sheet.getCell(currentRow, 2).value = chatroomId
        sheet.getCell(currentRow, 2).font = { name: 'Calibri', size: 11 }

        sheet.getCell(currentRow, 4).value = '昵称'
        sheet.getCell(currentRow, 4).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 5).value = groupName
        sheet.getCell(currentRow, 5).font = { name: 'Calibri', size: 11 }

        sheet.getCell(currentRow, 6).value = '备注'
        sheet.getCell(currentRow, 6).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.mergeCells(currentRow, 7, currentRow, 8)
        sheet.getCell(currentRow, 7).value = sessionRemark
        sheet.getCell(currentRow, 7).font = { name: 'Calibri', size: 11 }

        sheet.getRow(currentRow).height = 20
        currentRow++

        sheet.getCell(currentRow, 1).value = '导出工具'
        sheet.getCell(currentRow, 1).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 2).value = exportGenerator
        sheet.getCell(currentRow, 2).font = { name: 'Calibri', size: 10 }

        sheet.getCell(currentRow, 3).value = '导出版本'
        sheet.getCell(currentRow, 3).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 4).value = exportVersion
        sheet.getCell(currentRow, 4).font = { name: 'Calibri', size: 10 }

        sheet.getCell(currentRow, 5).value = '平台'
        sheet.getCell(currentRow, 5).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 6).value = exportPlatform
        sheet.getCell(currentRow, 6).font = { name: 'Calibri', size: 10 }

        sheet.getCell(currentRow, 7).value = '导出时间'
        sheet.getCell(currentRow, 7).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 8).value = exportTime
        sheet.getCell(currentRow, 8).font = { name: 'Calibri', size: 10 }

        sheet.getRow(currentRow).height = 20
        currentRow++

        const headerRow = sheet.getRow(currentRow)
        headerRow.height = 22
        header.forEach((text, index) => {
          const cell = headerRow.getCell(index + 1)
          cell.value = text
          cell.font = { name: 'Calibri', bold: true, size: 11 }
        })
        currentRow++

        sheet.getColumn(1).width = 28
        sheet.getColumn(2).width = 28
        sheet.getColumn(3).width = 28
        sheet.getColumn(4).width = 36
        sheet.getColumn(5).width = 28
        sheet.getColumn(6).width = 18
        sheet.getColumn(7).width = 24
        sheet.getColumn(8).width = 22

        for (let i = 4; i < rows.length; i++) {
          const [nickName, remark, groupNickname, wxid, alias] = rows[i]
          const row = sheet.getRow(currentRow)
          row.getCell(1).value = nickName
          row.getCell(2).value = remark
          row.getCell(3).value = groupNickname
          row.getCell(4).value = wxid
          row.getCell(5).value = alias
          row.alignment = { vertical: 'top', wrapText: true }
          currentRow++
        }

        await workbook.xlsx.writeFile(outputPath)
      }

      return { success: true, count: members.length }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }



}

export const groupAnalyticsService = new GroupAnalyticsService()
