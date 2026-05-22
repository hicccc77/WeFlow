import { wcdbService } from '../wcdbService'
import { CONTACT_REGION_LOOKUP_DATA } from '../contactRegionLookupData'
import { FRIEND_EXCLUDE_USERNAMES } from './constants'
import { getRowField, getRowInt } from './messageRowUtils'
import type { ContactInfo, GetContactsOptions } from './types'
import type { ContactsHost } from './contactsHost'

export class ContactsService {
  private readonly contactExtendedFieldCandidates = [
    'label_list', 'labelList', 'labels', 'label_names', 'labelNames', 'tags', 'tag_list', 'tagList',
    'detail_description', 'detailDescription', 'description', 'desc', 'contact_description', 'contactDescription', 'signature', 'sign',
    'country', 'province', 'city', 'region',
    'profile', 'introduction', 'phone', 'mobile', 'telephone', 'tel', 'vcard', 'card_info', 'cardInfo',
    'extra_buffer', 'extraBuffer'
  ]
  private readonly contactExtendedFieldCandidateSet = new Set(this.contactExtendedFieldCandidates.map((name) => name.toLowerCase()))
  private contactExtendedSelectableColumns: string[] | null = null
  private contactLabelNameMapCache: Map<number, string> | null = null
  private contactLabelNameMapCacheAt = 0
  private readonly contactLabelNameMapCacheTtlMs = 10 * 60 * 1000
  private contactsLoadInFlight: { mode: 'lite' | 'full'; promise: Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> } | null = null
  private contactsMemoryCache = new Map<'lite' | 'full', { scope: string; updatedAt: number; contacts: ContactInfo[] }>()
  private readonly contactsMemoryCacheTtlMs = 3 * 60 * 1000
  private readonly contactDisplayNameCollator = new Intl.Collator('zh-CN')
  private readonly slowGetContactsLogThresholdMs = 1200

  constructor(private readonly host: ContactsHost) {}

  clearMemoryCache(): void {
    this.contactsMemoryCache.clear()
    this.contactExtendedSelectableColumns = null
    this.contactLabelNameMapCache = null
    this.contactLabelNameMapCacheAt = 0
  }

  async getContacts(options?: GetContactsOptions): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    const mode: 'lite' | 'full' = options?.lite ? 'lite' : 'full'
    const inFlight = this.contactsLoadInFlight
    if (inFlight && (inFlight.mode === mode || (mode === 'lite' && inFlight.mode === 'full'))) {
      return await inFlight.promise
    }

    const promise = this.getContactsInternal(options)
    this.contactsLoadInFlight = { mode, promise }
    try {
      return await promise
    } finally {
      if (this.contactsLoadInFlight?.promise === promise) {
        this.contactsLoadInFlight = null
      }
    }
  }

  private getContactsCacheScope(): string {
    const dbPath = String(this.host.getDbPath() || '').trim()
    const myWxid = String(this.host.getMyWxidCleaned() || '').trim()
    return `${dbPath}::${myWxid}`
  }

  private cloneContacts(contacts: ContactInfo[]): ContactInfo[] {
    return (contacts || []).map((contact) => ({
      ...contact,
      labels: Array.isArray(contact.labels) ? [...contact.labels] : contact.labels
    }))
  }

  private getContactsFromMemoryCache(mode: 'lite' | 'full', scope: string): ContactInfo[] | null {
    const cached = this.contactsMemoryCache.get(mode)
    if (!cached) return null
    if (cached.scope !== scope) return null
    if (Date.now() - cached.updatedAt > this.contactsMemoryCacheTtlMs) return null
    return this.cloneContacts(cached.contacts)
  }

  private setContactsMemoryCache(mode: 'lite' | 'full', scope: string, contacts: ContactInfo[]): void {
    this.contactsMemoryCache.set(mode, {
      scope,
      updatedAt: Date.now(),
      contacts: this.cloneContacts(contacts)
    })
  }

  private async getContactsInternal(options?: GetContactsOptions): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    const isLiteMode = options?.lite === true
    const mode: 'lite' | 'full' = isLiteMode ? 'lite' : 'full'
    const cacheScope = this.getContactsCacheScope()
    const cachedContacts = this.getContactsFromMemoryCache(mode, cacheScope)
    if (cachedContacts) {
      return { success: true, contacts: cachedContacts }
    }
    if (isLiteMode) {
      const fullCachedContacts = this.getContactsFromMemoryCache('full', cacheScope)
      if (fullCachedContacts) {
        return { success: true, contacts: fullCachedContacts }
      }
    }

    const startedAt = Date.now()
    const stageDurations: Array<{ stage: string; ms: number }> = []
    const captureStage = (stage: string, stageStartedAt: number) => {
      stageDurations.push({ stage, ms: Date.now() - stageStartedAt })
    }

    try {
      const connectStartedAt = Date.now()
      const connectResult = await this.host.ensureConnected()
      captureStage('ensureConnected', connectStartedAt)
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const contactsCompactStartedAt = Date.now()
      const contactResult = await wcdbService.getContactsCompact()
      captureStage('getContactsCompact', contactsCompactStartedAt)

      if (!contactResult.success || !contactResult.contacts) {
        console.error('查询联系人失败:', contactResult.error)
        return { success: false, error: contactResult.error || '查询联系人失败' }
      }

      let rows = contactResult.contacts as Record<string, any>[]
      if (!isLiteMode) {
        const hydrateStartedAt = Date.now()
        rows = await this.hydrateContactsWithExtendedFields(rows)
        captureStage('hydrateContactsWithExtendedFields', hydrateStartedAt)
      }

      // 获取会话表的最后联系时间用于排序
      const sessionsStartedAt = Date.now()
      const lastContactTimeMap = new Map<string, number>()
      const sessionResult = await wcdbService.getSessions()
      captureStage('getSessions', sessionsStartedAt)
      if (sessionResult.success && sessionResult.sessions) {
        for (const session of sessionResult.sessions as any[]) {
          const username = session.username || session.user_name || session.userName || ''
          const timestamp = session.sort_timestamp || session.sortTimestamp || 0
          if (username && timestamp) {
            lastContactTimeMap.set(username, timestamp)
          }
        }
      }

      // 转换为ContactInfo
      const transformStartedAt = Date.now()
      const contacts: (ContactInfo & { lastContactTime: number })[] = []
      let contactLabelNameMap = new Map<number, string>()
      if (!isLiteMode) {
        const labelMapStartedAt = Date.now()
        contactLabelNameMap = await this.getContactLabelNameMap()
        captureStage('getContactLabelNameMap', labelMapStartedAt)
      }
      for (const row of rows) {
        const username = String(row.username || '').trim()

        if (!username) continue

        let type: 'friend' | 'group' | 'official' | 'former_friend' | 'other' = 'other'
        const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], 0)
        const quanPin = String(getRowField(row, ['quan_pin', 'quanPin', 'WCDB_CT_quan_pin']) || '').trim()
        const loweredUsername = username.toLowerCase()
        const isOpenimEnterprise = this.host.isEnterpriseOpenimUsername(username)
        if (isOpenimEnterprise && !this.host.isAllowedEnterpriseOpenimByLocalType(username, localType)) {
          continue
        }
        const isVisibleWeixinContact = loweredUsername.startsWith('weixin') && loweredUsername !== 'weixin'

        if (username.endsWith('@chatroom')) {
          type = 'group'
        } else if (username.startsWith('gh_')) {
          type = 'official'
        } else if (isOpenimEnterprise) {
          type = 'friend'
        } else if (isVisibleWeixinContact) {
          type = 'friend'
        } else if (localType === 1 && !FRIEND_EXCLUDE_USERNAMES.has(username)) {
          type = 'friend'
        } else if (localType === 0 && quanPin) {
          type = 'former_friend'
        } else {
          continue
        }

        const displayName = row.remark || row.nick_name || row.alias || username
        const labels = isLiteMode ? [] : this.parseContactLabels(row, contactLabelNameMap)
        const detailDescription = isLiteMode ? '' : this.getContactSignature(row)
        const region = isLiteMode ? '' : this.getContactRegion(row)

        contacts.push({
          username,
          displayName,
          remark: row.remark || undefined,
          nickname: row.nick_name || undefined,
          alias: row.alias || undefined,
          labels: labels.length > 0 ? labels : undefined,
          detailDescription: detailDescription || undefined,
          region: region || undefined,
          avatarUrl: undefined,
          type,
          lastContactTime: lastContactTimeMap.get(username) || 0
        })
      }
      captureStage('transformContacts', transformStartedAt)


      // 按最近联系时间排序
      const sortStartedAt = Date.now()
      contacts.sort((a, b) => {
        const timeA = a.lastContactTime || 0
        const timeB = b.lastContactTime || 0
        if (timeA && timeB) {
          return timeB - timeA
        }
        if (timeA && !timeB) return -1
        if (!timeA && timeB) return 1
        return this.contactDisplayNameCollator.compare(a.displayName, b.displayName)
      })
      captureStage('sortContacts', sortStartedAt)

      // 移除临时的lastContactTime字段
      const finalizeStartedAt = Date.now()
      const result = contacts.map(({ lastContactTime, ...rest }) => rest)
      captureStage('finalizeResult', finalizeStartedAt)

      const totalMs = Date.now() - startedAt
      if (totalMs >= this.slowGetContactsLogThresholdMs) {
        const stageSummary = stageDurations
          .map((item) => `${item.stage}=${item.ms}ms`)
          .join(', ')
        console.warn(`[ChatService] getContacts(${isLiteMode ? 'lite' : 'full'}) 慢查询 total=${totalMs}ms, ${stageSummary}`)
      }
      this.setContactsMemoryCache(mode, cacheScope, result)
      if (!isLiteMode) {
        this.setContactsMemoryCache('lite', cacheScope, result)
      }
      return { success: true, contacts: result }
    } catch (e) {
      console.error('ChatService: 获取通讯录失败:', e)
      return { success: false, error: String(e) }
    }
  }
  private hasAnyContactExtendedFieldKey(row: Record<string, any>): boolean {
    for (const key of Object.keys(row || {})) {
      if (this.contactExtendedFieldCandidateSet.has(String(key || '').toLowerCase())) {
        return true
      }
    }
    return false
  }

  private async hydrateContactsWithExtendedFields(rows: Record<string, any>[]): Promise<Record<string, any>[]> {
    if (!Array.isArray(rows) || rows.length === 0) return rows
    const hasAnyExtendedFieldKey = rows.some((row) => this.hasAnyContactExtendedFieldKey(row || {}))
    if (hasAnyExtendedFieldKey) {
      // wcdb_get_contacts_compact 可能只给“部分联系人”返回 extra_buffer。
      // 只有在每一行都能拿到可解析的 extra_buffer 时才跳过补偿查询。
      const allRowsHaveUsableExtraBuffer = rows.every((row) => this.toExtraBufferBytes(row || {}) !== null)
      if (allRowsHaveUsableExtraBuffer) return rows
    }

    try {
      let selectableColumns = this.contactExtendedSelectableColumns
      if (!selectableColumns) {
        const tableInfoResult = await wcdbService.execQuery('contact', null, 'PRAGMA table_info(contact)')
        if (!tableInfoResult.success || !Array.isArray(tableInfoResult.rows)) {
          return rows
        }

        const availableColumns = new Map<string, string>()
        for (const tableInfoRow of tableInfoResult.rows as Record<string, any>[]) {
          const rawName = tableInfoRow.name ?? tableInfoRow.column_name ?? tableInfoRow.columnName
          const name = String(rawName || '').trim()
          if (!name) continue
          availableColumns.set(name.toLowerCase(), name)
        }

        const resolvedColumns: string[] = []
        const seenColumns = new Set<string>()
        for (const candidate of this.contactExtendedFieldCandidates) {
          const actual = availableColumns.get(candidate.toLowerCase())
          if (!actual) continue
          const normalized = actual.toLowerCase()
          if (seenColumns.has(normalized)) continue
          seenColumns.add(normalized)
          resolvedColumns.push(actual)
        }

        this.contactExtendedSelectableColumns = resolvedColumns
        selectableColumns = resolvedColumns
      }

      if (selectableColumns.length === 0) return rows

      const selectColumns = ['username', ...selectableColumns]
      const sql = `SELECT ${selectColumns.map((column) => this.host.quoteSqlIdentifier(column)).join(', ')} FROM contact WHERE username IS NOT NULL AND username != ''`
      const extendedResult = await wcdbService.execQuery('contact', null, sql)
      if (!extendedResult.success || !Array.isArray(extendedResult.rows) || extendedResult.rows.length === 0) {
        return rows
      }

      const extendedByUsername = new Map<string, Record<string, any>>()
      for (const extendedRow of extendedResult.rows as Record<string, any>[]) {
        const username = String(extendedRow.username || '').trim()
        if (!username) continue
        extendedByUsername.set(username, extendedRow)
      }
      if (extendedByUsername.size === 0) return rows

      return rows.map((row) => {
        const username = String(row.username || row.user_name || row.userName || '').trim()
        if (!username) return row
        const extended = extendedByUsername.get(username)
        if (!extended) return row
        return {
          ...extended,
          ...row
        }
      })
    } catch (error) {
      console.warn('联系人扩展字段补偿查询失败:', error)
      return rows
    }
  }

  private async getContactLabelNameMap(): Promise<Map<number, string>> {
    const now = Date.now()
    if (this.contactLabelNameMapCache && now - this.contactLabelNameMapCacheAt <= this.contactLabelNameMapCacheTtlMs) {
      return new Map(this.contactLabelNameMapCache)
    }

    const labelMap = new Map<number, string>()
    try {
      const tableInfoResult = await wcdbService.execQuery('contact', null, 'PRAGMA table_info(contact_label)')
      if (!tableInfoResult.success || !Array.isArray(tableInfoResult.rows) || tableInfoResult.rows.length === 0) {
        this.contactLabelNameMapCache = labelMap
        this.contactLabelNameMapCacheAt = now
        return labelMap
      }

      const availableColumns = new Map<string, string>()
      for (const tableInfoRow of tableInfoResult.rows as Record<string, any>[]) {
        const rawName = tableInfoRow.name ?? tableInfoRow.column_name ?? tableInfoRow.columnName
        const name = String(rawName || '').trim()
        if (!name) continue
        availableColumns.set(name.toLowerCase(), name)
      }

      const pickColumn = (candidates: string[]): string | null => {
        for (const candidate of candidates) {
          const actual = availableColumns.get(candidate.toLowerCase())
          if (actual) return actual
        }
        return null
      }

      const idColumn = pickColumn(['label_id_', 'label_id', 'labelId', 'labelid', 'id'])
      const nameColumn = pickColumn(['label_name_', 'label_name', 'labelName', 'labelname', 'name'])
      if (!idColumn || !nameColumn) {
        this.contactLabelNameMapCache = labelMap
        this.contactLabelNameMapCacheAt = now
        return labelMap
      }

      const sql = `SELECT ${this.host.quoteSqlIdentifier(idColumn)} AS label_id, ${this.host.quoteSqlIdentifier(nameColumn)} AS label_name FROM contact_label`
      const result = await wcdbService.execQuery('contact', null, sql)
      if (result.success && Array.isArray(result.rows)) {
        for (const row of result.rows as Record<string, any>[]) {
          const id = Number(String(row.label_id ?? row.labelId ?? '').trim())
          const name = String(row.label_name ?? row.labelName ?? '').trim()
          if (Number.isFinite(id) && id > 0 && name) {
            labelMap.set(Math.floor(id), name)
          }
        }
      }
    } catch (error) {
      console.warn('读取 contact_label 失败:', error)
    }

    this.contactLabelNameMapCache = labelMap
    this.contactLabelNameMapCacheAt = now
    return new Map(labelMap)
  }

  private toExtraBufferBytes(row: Record<string, any>): Buffer | null {
    const raw = getRowField(row, ['extra_buffer', 'extraBuffer'])
    if (raw === undefined || raw === null) return null
    if (Buffer.isBuffer(raw)) return raw.length > 0 ? raw : null
    if (raw instanceof Uint8Array) return raw.length > 0 ? Buffer.from(raw) : null
    if (Array.isArray(raw)) {
      const bytes = Buffer.from(raw)
      return bytes.length > 0 ? bytes : null
    }

    const text = String(raw || '').trim()
    if (!text) return null
    const compact = text.replace(/\s+/g, '')
    if (compact.length >= 2 && compact.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(compact)) {
      try {
        const bytes = Buffer.from(compact, 'hex')
        return bytes.length > 0 ? bytes : null
      } catch {
        return null
      }
    }
    return null
  }

  private readProtoVarint(buffer: Buffer, offset: number): { value: number; nextOffset: number } | null {
    if (!buffer || offset < 0 || offset >= buffer.length) return null
    let value = 0
    let shift = 0
    let index = offset
    while (index < buffer.length) {
      const byte = buffer[index]
      index += 1
      value += (byte & 0x7f) * Math.pow(2, shift)
      if ((byte & 0x80) === 0) {
        return { value, nextOffset: index }
      }
      shift += 7
      if (shift > 56) return null
    }
    return null
  }

  private extractExtraBufferTopLevelFieldStrings(row: Record<string, any>, targetField: number): string[] {
    const bytes = this.toExtraBufferBytes(row)
    if (!bytes || !Number.isFinite(targetField) || targetField <= 0) return []
    const values: string[] = []
    let offset = 0
    while (offset < bytes.length) {
      const tagResult = this.readProtoVarint(bytes, offset)
      if (!tagResult) break
      offset = tagResult.nextOffset
      const fieldNumber = Math.floor(tagResult.value / 8)
      const wireType = tagResult.value & 0x07

      if (wireType === 0) {
        const varint = this.readProtoVarint(bytes, offset)
        if (!varint) break
        offset = varint.nextOffset
        continue
      }

      if (wireType === 1) {
        if (offset + 8 > bytes.length) break
        offset += 8
        continue
      }

      if (wireType === 2) {
        const lengthResult = this.readProtoVarint(bytes, offset)
        if (!lengthResult) break
        const payloadLength = Math.floor(lengthResult.value)
        offset = lengthResult.nextOffset
        if (payloadLength < 0 || offset + payloadLength > bytes.length) break
        const payload = bytes.subarray(offset, offset + payloadLength)
        offset += payloadLength
        if (fieldNumber === targetField) {
          const text = payload.toString('utf-8').replace(/\u0000/g, '').trim()
          if (text) values.push(text)
        }
        continue
      }

      if (wireType === 5) {
        if (offset + 4 > bytes.length) break
        offset += 4
        continue
      }

      break
    }
    return values
  }

  private parseContactLabelsFromExtraBuffer(row: Record<string, any>, labelNameMap?: Map<number, string>): string[] {
    const labelNames: string[] = []
    const seen = new Set<string>()
    const texts = this.extractExtraBufferTopLevelFieldStrings(row, 30)
    for (const text of texts) {
      const matches = text.match(/\d+/g) || []
      for (const match of matches) {
        const id = Number(match)
        if (!Number.isFinite(id) || id <= 0) continue
        const labelName = labelNameMap?.get(Math.floor(id))
        if (!labelName) continue
        if (seen.has(labelName)) continue
        seen.add(labelName)
        labelNames.push(labelName)
      }
    }
    return labelNames
  }

  private parseContactLabels(row: Record<string, any>, labelNameMap?: Map<number, string>): string[] {
    const raw = getRowField(row, [
      'label_list', 'labelList', 'labels', 'label_names', 'labelNames', 'tags', 'tag_list', 'tagList'
    ])
    const normalizedFromValue = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
      }
      const text = String(value || '').trim()
      if (!text) return []
      return Array.from(new Set(
        text
          .replace(/[；;、|]+/g, ',')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      ))
    }

    const direct = normalizedFromValue(raw)
    if (direct.length > 0) return direct

    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.toLowerCase()
      if (!normalizedKey.includes('label') && !normalizedKey.includes('tag')) continue
      if (normalizedKey.includes('img') || normalizedKey.includes('head')) continue
      const fallback = normalizedFromValue(value)
      if (fallback.length > 0) return fallback
    }

    const extraBufferLabels = this.parseContactLabelsFromExtraBuffer(row, labelNameMap)
    if (extraBufferLabels.length > 0) return extraBufferLabels

    return []
  }

  private getContactSignature(row: Record<string, any>): string {
    const normalize = (raw: unknown): string => {
      const text = String(raw || '').replace(/\u0000/g, '').trim()
      if (!text) return ''
      const lower = text.toLowerCase()
      if (lower === '-' || lower === '--' || lower === '—' || lower === 'null' || lower === 'undefined' || lower === 'none') {
        return ''
      }
      return text
    }

    const value = getRowField(row, [
      'signature', 'sign', 'personal_signature', 'personalSignature', 'profile', 'introduction',
      'detail_description', 'detailDescription', 'description', 'desc', 'contact_description', 'contactDescription'
    ])
    const direct = normalize(value)
    if (direct) return direct

    for (const [key, rawValue] of Object.entries(row)) {
      const normalizedKey = key.toLowerCase()
      const isCandidate =
        normalizedKey.includes('sign') ||
        normalizedKey.includes('signature') ||
        normalizedKey.includes('profile') ||
        normalizedKey.includes('intro') ||
        normalizedKey.includes('description') ||
        normalizedKey.includes('detail') ||
        normalizedKey.includes('desc')
      if (!isCandidate) continue
      if (
        normalizedKey.includes('avatar') ||
        normalizedKey.includes('img') ||
        normalizedKey.includes('head') ||
        normalizedKey.includes('label') ||
        normalizedKey.includes('tag')
      ) continue
      const text = normalize(rawValue)
      if (text) return text
    }

    // contact.extra_buffer field 4: 个性签名兜底
    const signatures = this.extractExtraBufferTopLevelFieldStrings(row, 4)
    for (const signature of signatures) {
      const text = normalize(signature)
      if (!text) continue
      return text
    }

    return ''
  }

  private normalizeContactRegionPart(raw: unknown): string {
    const text = String(raw || '').replace(/\u0000/g, '').trim()
    if (!text) return ''
    const lower = text.toLowerCase()
    if (lower === '-' || lower === '--' || lower === '—' || lower === 'null' || lower === 'undefined' || lower === 'none') {
      return ''
    }
    return text
  }

  private normalizeRegionLookupKey(raw: string): string {
    return String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
  }

  private buildRegionLookupCandidates(raw: string): string[] {
    const normalized = this.normalizeRegionLookupKey(raw)
    if (!normalized) return []

    const candidates = new Set<string>([normalized])
    const withoutTrailingDigits = normalized.replace(/\d+$/g, '')
    if (withoutTrailingDigits) candidates.add(withoutTrailingDigits)

    return Array.from(candidates)
  }

  private normalizeChineseProvinceName(raw: string): string {
    const text = String(raw || '').trim()
    if (!text) return ''
    return text
      .replace(/特别行政区$/g, '')
      .replace(/维吾尔自治区$/g, '')
      .replace(/壮族自治区$/g, '')
      .replace(/回族自治区$/g, '')
      .replace(/自治区$/g, '')
      .replace(/省$/g, '')
      .replace(/市$/g, '')
      .trim()
  }

  private normalizeChineseCityName(raw: string): string {
    const text = String(raw || '').trim()
    if (!text) return ''
    return text
      .replace(/特别行政区$/g, '')
      .replace(/自治州$/g, '')
      .replace(/地区$/g, '')
      .replace(/盟$/g, '')
      .replace(/林区$/g, '')
      .replace(/市$/g, '')
      .trim()
  }

  private resolveProvinceLookupKey(raw: string): string {
    const candidates = this.buildRegionLookupCandidates(raw)
    if (candidates.length === 0) return ''

    for (const candidate of candidates) {
      const byName = CONTACT_REGION_LOOKUP_DATA.provinceKeyByName[candidate]
      if (byName) return byName
      if (CONTACT_REGION_LOOKUP_DATA.provinceNameByKey[candidate]) return candidate
    }

    return candidates[0]
  }

  private toChineseCountryName(raw: string): string {
    const text = this.normalizeContactRegionPart(raw)
    if (!text) return ''

    const candidates = this.buildRegionLookupCandidates(text)
    for (const candidate of candidates) {
      const mapped = CONTACT_REGION_LOOKUP_DATA.countryNameByKey[candidate]
      if (mapped) return mapped
    }
    return text
  }

  private toChineseProvinceName(raw: string): string {
    const text = this.normalizeContactRegionPart(raw)
    if (!text) return ''

    const candidates = this.buildRegionLookupCandidates(text)
    if (candidates.length === 0) return text
    const provinceKey = this.resolveProvinceLookupKey(text)
    const mappedFromCandidates = candidates
      .map((candidate) => CONTACT_REGION_LOOKUP_DATA.provinceNameByKey[candidate])
      .find(Boolean)
    const mapped = CONTACT_REGION_LOOKUP_DATA.provinceNameByKey[provinceKey] || mappedFromCandidates
    if (mapped) return mapped

    if (/[\u4e00-\u9fa5]/.test(text)) {
      return this.normalizeChineseProvinceName(text) || text
    }

    return text
  }

  private toChineseCityName(raw: string, provinceRaw?: string): string {
    const text = this.normalizeContactRegionPart(raw)
    if (!text) return ''

    const candidates = this.buildRegionLookupCandidates(text)
    if (candidates.length === 0) return text

    const provinceKey = this.resolveProvinceLookupKey(String(provinceRaw || ''))
    if (provinceKey) {
      const byProvince = CONTACT_REGION_LOOKUP_DATA.cityNameByProvinceKey[provinceKey]
      if (byProvince) {
        for (const candidate of candidates) {
          const mappedInProvince = byProvince[candidate]
          if (mappedInProvince) return mappedInProvince
        }
      }
    }

    for (const candidate of candidates) {
      const mapped = CONTACT_REGION_LOOKUP_DATA.cityNameByKey[candidate]
      if (mapped) return mapped
    }

    if (/[\u4e00-\u9fa5]/.test(text)) {
      return this.normalizeChineseCityName(text) || text
    }

    return text
  }

  private toChineseRegionText(raw: string): string {
    const text = this.normalizeContactRegionPart(raw)
    if (!text) return ''
    const tokens = text
      .split(/[\s,，、/|·]+/)
      .map((item) => this.normalizeContactRegionPart(item))
      .filter(Boolean)
    if (tokens.length === 0) return text

    let provinceContext = ''
    const mapped = tokens.map((token) => {
      const country = this.toChineseCountryName(token)
      if (country !== token) return country

      const province = this.toChineseProvinceName(token)
      if (province !== token) {
        provinceContext = province
        return province
      }

      const city = this.toChineseCityName(token, provinceContext)
      if (city !== token) return city

      return token
    })
    return mapped.join(' ').trim()
  }

  private shouldHideCountryInRegion(country: string, hasProvinceOrCity: boolean): boolean {
    if (!country) return true
    const normalized = country.toLowerCase()
    if (normalized === 'cn' || normalized === 'chn' || normalized === 'china' || normalized === '中国') {
      return hasProvinceOrCity
    }
    return false
  }

  private getContactRegion(row: Record<string, any>): string {
    const pickByTokens = (tokens: string[]): string => {
      for (const [key, value] of Object.entries(row || {})) {
        const normalizedKey = String(key || '').toLowerCase()
        if (!normalizedKey) continue
        if (normalizedKey.includes('avatar') || normalizedKey.includes('img') || normalizedKey.includes('head')) continue
        if (!tokens.some((token) => normalizedKey.includes(token))) continue
        const text = this.normalizeContactRegionPart(value)
        if (text) return text
      }
      return ''
    }

    const directCountry = this.normalizeContactRegionPart(getRowField(row, ['country', 'Country'])) || pickByTokens(['country'])
    const directProvince = this.normalizeContactRegionPart(getRowField(row, ['province', 'Province'])) || pickByTokens(['province'])
    const directCity = this.normalizeContactRegionPart(getRowField(row, ['city', 'City'])) || pickByTokens(['city'])
    const directRegion =
      this.normalizeContactRegionPart(getRowField(row, ['region', 'Region', 'location', 'area'])) ||
      pickByTokens(['region', 'location', 'area', 'addr', 'address'])

    if (directRegion) {
      const normalizedRegion = this.toChineseRegionText(directRegion)
      const parts = normalizedRegion
        .split(/\s+/)
        .map((item) => this.normalizeContactRegionPart(item))
        .filter(Boolean)
      if (parts.length > 1 && this.shouldHideCountryInRegion(parts[0], true)) {
        return parts.slice(1).join(' ').trim()
      }
      return normalizedRegion
    }

    const fallbackCountry = this.normalizeContactRegionPart(this.extractExtraBufferTopLevelFieldStrings(row, 5)[0] || '')
    const fallbackProvince = this.normalizeContactRegionPart(this.extractExtraBufferTopLevelFieldStrings(row, 6)[0] || '')
    const fallbackCity = this.normalizeContactRegionPart(this.extractExtraBufferTopLevelFieldStrings(row, 7)[0] || '')

    const country = this.toChineseCountryName(directCountry || fallbackCountry)
    const province = this.toChineseProvinceName(directProvince || fallbackProvince)
    const city = this.toChineseCityName(directCity || fallbackCity, directProvince || fallbackProvince)

    const hasProvinceOrCity = Boolean(province || city)
    const parts: string[] = []
    if (!this.shouldHideCountryInRegion(country, hasProvinceOrCity)) {
      parts.push(country)
    }
    if (province) {
      parts.push(province)
    }
    if (city && city !== province) {
      parts.push(city)
    }

    return parts.join(' ').trim()
  }

}
