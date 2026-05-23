import * as fs from 'fs'
import * as path from 'path'
import { FILE_APP_LOCAL_TYPE_SET, MESSAGE_TYPE_MAP, type ExportOptions, type ExportProgress, type ExportTaskControl } from './exportServiceTypes'

export const STOP_ERROR_CODE = 'WEFLOW_EXPORT_STOP_REQUESTED'
export const PAUSE_ERROR_CODE = 'WEFLOW_EXPORT_PAUSE_REQUESTED'

export function normalizeSessionIds(sessionIds: string[]): string[] {
  return Array.from(
    new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))
  )
}

export function normalizeTimestampSeconds(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  let normalized = Math.floor(raw)
  // 兼容毫秒/微秒/纳秒时间戳输入，统一降到秒级。
  while (normalized > 10000000000) {
    normalized = Math.floor(normalized / 1000)
  }
  return normalized
}

export function normalizeExportDateRange(dateRange?: { start: number; end: number } | null): { start: number; end: number } | null {
  if (!dateRange) return null
  let start = normalizeTimestampSeconds(dateRange.start)
  let end = normalizeTimestampSeconds(dateRange.end)
  if (start > 0 && end > 0 && start > end) {
    const tmp = start
    start = end
    end = tmp
  }
  if (start <= 0 && end <= 0) return null
  return { start, end }
}

export function normalizeMaxFileSizeMb(value: unknown): number | undefined {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return undefined
  return Math.floor(raw)
}

export function getExportStatsDateRangeToken(dateRange?: { start: number; end: number } | null): string {
  const normalized = normalizeExportDateRange(dateRange)
  if (!normalized) return 'all'
  const start = normalized.start
  const end = normalized.end
  return `${start}-${end}`
}

export function sanitizeExportFileNamePart(value: string): string {
  return String(value || '')
    .replace(/[<>:"\/\\|?*]/g, '_')
    .replace(/\.+$/, '')
    .trim()
}

export function resolveFileAttachmentExtensionDir(msg: any, fileName: string): string {
  const rawExt = String(msg?.fileExt || '').trim() || path.extname(String(fileName || ''))
  const normalizedExt = rawExt.replace(/^\.+/, '').trim().toLowerCase()
  const safeExt = sanitizeExportFileNamePart(normalizedExt).replace(/\s+/g, '_')
  return safeExt || 'no-extension'
}

export function normalizeFileNamingMode(value: unknown): 'classic' | 'date-range' {
  return String(value || '').trim().toLowerCase() === 'date-range' ? 'date-range' : 'classic'
}

export function formatDateTokenBySeconds(seconds?: number): string | null {
  const normalizedSeconds = normalizeTimestampSeconds(seconds)
  if (normalizedSeconds <= 0) return null
  const date = new Date(normalizedSeconds * 1000)
  if (Number.isNaN(date.getTime())) return null
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}${m}${d}`
}

export function buildDateRangeFileNamePart(dateRange?: { start: number; end: number } | null): string {
  const start = formatDateTokenBySeconds(dateRange?.start)
  const end = formatDateTokenBySeconds(dateRange?.end)
  if (start && end) {
    if (start === end) return start
    return start < end ? `${start}-${end}` : `${end}-${start}`
  }
  if (start) return `${start}-至今`
  if (end) return `截至-${end}`
  return '全部时间'
}

export function buildSessionExportBaseName(
  sessionId: string,
  displayName: string,
  options: ExportOptions
): string {
  const baseName = sanitizeExportFileNamePart(displayName || sessionId) || sanitizeExportFileNamePart(sessionId) || 'session'
  const suffix = sanitizeExportFileNamePart(options.fileNameSuffix || '')
  const namingMode = normalizeFileNamingMode(options.fileNamingMode)
  const parts = [baseName]
  if (suffix) parts.push(suffix)
  if (namingMode === 'date-range') {
    parts.push(buildDateRangeFileNamePart(options.dateRange))
  }
  return sanitizeExportFileNamePart(parts.join('_')) || 'session'
}

export function isCloneUnsupportedError(code: string | undefined): boolean {
  return code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EINVAL' || code === 'EXDEV' || code === 'ENOTTY'
}

export function isHardlinkFallbackError(code: string | undefined): boolean {
  return code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EINVAL' || code === 'ENOSYS' || code === 'ENOTSUP'
}

export function cleanAccountDirName(dirName: string): string {
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

export function getIntFromRow(row: Record<string, any>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const raw = row?.[key]
    if (raw === undefined || raw === null || raw === '') continue
    const parsed = Number.parseInt(String(raw), 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function parseCompactDateTimeDigitsToSeconds(value: string): number {
  const raw = String(value || '').trim()
  if (!/^\d{8}(?:\d{4}(?:\d{2})?)?$/.test(raw)) return 0

  const year = Number.parseInt(raw.slice(0, 4), 10)
  const month = Number.parseInt(raw.slice(4, 6), 10)
  const day = Number.parseInt(raw.slice(6, 8), 10)
  const hour = raw.length >= 12 ? Number.parseInt(raw.slice(8, 10), 10) : 0
  const minute = raw.length >= 12 ? Number.parseInt(raw.slice(10, 12), 10) : 0
  const second = raw.length >= 14 ? Number.parseInt(raw.slice(12, 14), 10) : 0

  if (!Number.isFinite(year) || year < 1990 || year > 2200) return 0
  if (!Number.isFinite(month) || month < 1 || month > 12) return 0
  if (!Number.isFinite(day) || day < 1 || day > 31) return 0
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return 0
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return 0
  if (!Number.isFinite(second) || second < 0 || second > 59) return 0

  const dt = new Date(year, month - 1, day, hour, minute, second)
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day ||
    dt.getHours() !== hour ||
    dt.getMinutes() !== minute ||
    dt.getSeconds() !== second
  ) {
    return 0
  }

  const ts = Math.floor(dt.getTime() / 1000)
  return Number.isFinite(ts) && ts > 0 ? ts : 0
}

export function parseDateTimeTextToSeconds(value: string): number {
  const raw = String(value || '').trim()
  if (!raw) return 0
  const compactDigits = parseCompactDateTimeDigitsToSeconds(raw)
  if (compactDigits > 0) return compactDigits

  // 优先处理带时区信息的格式（例如 2026-04-22T21:33:12Z / +08:00）
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = Date.parse(raw)
    const seconds = Math.floor(parsed / 1000)
    if (Number.isFinite(seconds) && seconds > 0) return seconds
  }

  const normalized = raw.replace('T', ' ').replace(/\.\d+$/, '').replace(/\//g, '-')
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (!match) return 0
  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  const hour = Number.parseInt(match[4] || '0', 10)
  const minute = Number.parseInt(match[5] || '0', 10)
  const second = Number.parseInt(match[6] || '0', 10)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return 0
  const dt = new Date(year, month - 1, day, hour, minute, second)
  const ts = Math.floor(dt.getTime() / 1000)
  return Number.isFinite(ts) && ts > 0 ? ts : 0
}

export function normalizeRowTimestampSeconds(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const rawText = String(value || '').trim()
  if (!rawText) return 0

  // 纯数字且看起来是年月日时间串时，优先按日期解析，避免误当作毫秒。
  const compactDigits = parseCompactDateTimeDigitsToSeconds(rawText)
  if (compactDigits > 0) return compactDigits

  const numeric = Number(rawText)
  if (Number.isFinite(numeric) && numeric > 0) {
    return normalizeTimestampSeconds(numeric)
  }

  return parseDateTimeTextToSeconds(rawText)
}

export function getTimestampSecondsFromRow(row: Record<string, any>): number {
  const rawPrimary = getRowField(row, [
    'create_time', 'createTime', 'createtime',
    'msg_create_time', 'msgCreateTime',
    'msg_time', 'msgTime', 'time',
    'WCDB_CT_create_time'
  ])
  let primary = normalizeRowTimestampSeconds(rawPrimary)

  const rawSortSeq = getRowField(row, ['sort_seq', 'sortSeq', 'server_seq', 'serverSeq'])
  const sortSeqSeconds = normalizeRowTimestampSeconds(rawSortSeq)

  // 对异常小时间戳兜底（例如 parseInt("2026-...") => 2026），优先回退 sort_seq。
  if (primary > 0 && primary < 946684800 && sortSeqSeconds > 946684800) {
    return sortSeqSeconds
  }
  if (primary > 0) return primary
  if (sortSeqSeconds > 0) return sortSeqSeconds
  return 0
}

export function getRowField(row: Record<string, any>, keys: string[]): any {
  for (const key of keys) {
    if (row && Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key]
      if (value !== undefined && value !== null && value !== '') {
        return value
      }
    }
  }
  return undefined
}

export function normalizeUnsignedIntToken(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return '0'
  if (/^\d+$/.test(raw)) {
    return raw.replace(/^0+(?=\d)/, '')
  }
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return '0'
  return String(Math.floor(num))
}

export function getStableMessageKey(msg: { localId?: unknown; createTime?: unknown; serverId?: unknown; serverIdRaw?: unknown }): string {
  const localId = normalizeUnsignedIntToken(msg?.localId)
  const createTime = normalizeUnsignedIntToken(msg?.createTime)
  const serverId = normalizeUnsignedIntToken(msg?.serverIdRaw ?? msg?.serverId)
  return `${localId}:${createTime}:${serverId}`
}

export function getMediaCacheKey(msg: { localType?: unknown; localId?: unknown; createTime?: unknown; serverId?: unknown; serverIdRaw?: unknown }): string {
  const localType = normalizeUnsignedIntToken(msg?.localType)
  return `${localType}_${getStableMessageKey(msg)}`
}

export function getImageMissingRunCacheKey(
  sessionId: string,
  imageMd5?: unknown,
  imageDatName?: unknown
): string | null {
  const normalizedSessionId = String(sessionId || '').trim()
  const normalizedImageMd5 = String(imageMd5 || '').trim().toLowerCase()
  const normalizedImageDatName = String(imageDatName || '').trim().toLowerCase()
  if (!normalizedSessionId) return null
  if (!normalizedImageMd5 && !normalizedImageDatName) return null

  const primaryToken = normalizedImageMd5 || normalizedImageDatName
  const secondaryToken = normalizedImageMd5 && normalizedImageDatName && normalizedImageDatName !== normalizedImageMd5
    ? normalizedImageDatName
    : ''
  return `${normalizedSessionId}\u001f${primaryToken}\u001f${secondaryToken}`
}

export function normalizeEmojiMd5(value: unknown): string | undefined {
  const md5 = String(value || '').trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(md5)) return undefined
  return md5
}

export function normalizeEmojiCaption(value: unknown): string | null {
  const caption = String(value || '').trim()
  if (!caption) return null
  return caption
}

export function formatEmojiSemanticText(caption?: string | null): string {
  const normalizedCaption = normalizeEmojiCaption(caption)
  if (!normalizedCaption) return '[表情包]'
  return `[表情包：${normalizedCaption}]`
}

export function extractLooseHexMd5(content: string): string | undefined {
  if (!content) return undefined
  const keyedMatch =
    /(?:emoji|sticker|md5)[^a-fA-F0-9]{0,32}([a-fA-F0-9]{32})/i.exec(content) ||
    /([a-fA-F0-9]{32})/i.exec(content)
  return normalizeEmojiMd5(keyedMatch?.[1] || keyedMatch?.[0])
}

export function normalizeEmojiCdnUrl(value: unknown): string | undefined {
  let url = String(value || '').trim()
  if (!url) return undefined
  url = url.replace(/&amp;/g, '&')
  try {
    if (url.includes('%')) {
      url = decodeURIComponent(url)
    }
  } catch {
    // keep original URL if decoding fails
  }
  return url.trim() || undefined
}

export function isFileAppLocalType(localType: number): boolean {
  return FILE_APP_LOCAL_TYPE_SET.has(localType)
}

export function getFileAppMessageHints(message: Record<string, any> | null | undefined): {
  xmlType?: string
  fileName?: string
  fileSize?: number
  fileExt?: string
  fileMd5?: string
} {
  const xmlType = String(message?.xmlType ?? message?.xml_type ?? '').trim() || undefined
  const fileName = String(message?.fileName ?? message?.file_name ?? '').trim() || undefined
  const fileExt = String(message?.fileExt ?? message?.file_ext ?? '').trim() || undefined
  const fileSizeRaw = Number(message?.fileSize ?? message?.file_size ?? message?.total_len ?? message?.totalLen ?? message?.totallen ?? 0)
  const fileSize = Number.isFinite(fileSizeRaw) && fileSizeRaw > 0 ? Math.floor(fileSizeRaw) : undefined
  const fileMd5Raw = String(message?.fileMd5 ?? message?.file_md5 ?? '').trim()
  const fileMd5 = /^[a-f0-9]{32}$/i.test(fileMd5Raw) ? fileMd5Raw.toLowerCase() : undefined
  return { xmlType, fileName, fileSize, fileExt, fileMd5 }
}

export function hasFileAppMessageHints(message: Record<string, any> | null | undefined): boolean {
  const hints = getFileAppMessageHints(message)
  if (hints.xmlType) return hints.xmlType === '6'
  return Boolean(hints.fileName || hints.fileExt || hints.fileMd5 || hints.fileSize)
}

export function decodeExtBuffer(value: unknown): Buffer | null {
  if (!value) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)

  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return null

    if (looksLikeHex(raw)) {
      try { return Buffer.from(raw, 'hex') } catch { }
    }
    if (looksLikeBase64(raw)) {
      try { return Buffer.from(raw, 'base64') } catch { }
    }

    try { return Buffer.from(raw, 'hex') } catch { }
    try { return Buffer.from(raw, 'base64') } catch { }
    try { return Buffer.from(raw, 'utf8') } catch { }
    return null
  }

  return null
}

export function readVarint(buffer: Buffer, offset: number, limit: number = buffer.length): { value: number; next: number } | null {
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

export function isLikelyGroupMemberId(value: string): boolean {
  const id = String(value || '').trim()
  if (!id) return false
  if (id.includes('@chatroom')) return false
  if (id.length < 4 || id.length > 80) return false
  return /^[A-Za-z][A-Za-z0-9_.@-]*$/.test(id)
}

export function parseGroupNicknamesFromExtBuffer(buffer: Buffer, candidates: string[] = []): Map<string, string> {
  const nicknameMap = new Map<string, string>()
  if (!buffer || buffer.length === 0) return nicknameMap

  try {
    const candidateSet = new Set(buildGroupNicknameIdCandidates(candidates).map((id) => id.toLowerCase()))

    for (let i = 0; i < buffer.length - 2; i += 1) {
      if (buffer[i] !== 0x0a) continue

      const idLenInfo = readVarint(buffer, i + 1)
      if (!idLenInfo) continue
      const idLen = idLenInfo.value
      if (!Number.isFinite(idLen) || idLen <= 0 || idLen > 96) continue

      const idStart = idLenInfo.next
      const idEnd = idStart + idLen
      if (idEnd > buffer.length) continue

      const memberId = buffer.toString('utf8', idStart, idEnd).trim()
      if (!isLikelyGroupMemberId(memberId)) continue

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

      const nickLenInfo = readVarint(buffer, cursor + 1)
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
      const nickname = normalizeGroupNickname(rawNick.replace(/[\x00-\x1F\x7F]/g, '').trim())
      if (!nickname) {
        i = nickEnd - 1
        continue
      }

      const aliases = buildGroupNicknameIdCandidates([memberId])
      for (const alias of aliases) {
        if (!alias) continue
        if (!nicknameMap.has(alias)) nicknameMap.set(alias, nickname)
        const lower = alias.toLowerCase()
        if (!nicknameMap.has(lower)) nicknameMap.set(lower, nickname)
      }

      i = nickEnd - 1
    }
  } catch (e) {
    console.error('Failed to parse chat_room.ext_buffer in exportService:', e)
  }

  return nicknameMap
}

/**
 * 转换微信消息类型到 ChatLab 类型
 */

/**
 * 解码消息内容
 */

export function looksLikeBase64(s: string): boolean {
  if (!s || s.length < 8) return false
  if (s.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/=]+$/.test(s)
}

export function looksLikeHex(s: string): boolean {
  if (s.length % 2 !== 0) return false
  return /^[0-9a-fA-F]+$/.test(s)
}

export function normalizeGroupNickname(value: string): string {
  const trimmed = (value || '').trim()
  if (!trimmed) return ''
  const cleaned = trimmed.replace(/[\x00-\x1F\x7F]/g, '')
  if (!cleaned) return ''
  if (/^[,"'“”‘’，、]+$/.test(cleaned)) return ''
  return cleaned
}

export function buildGroupNicknameIdCandidates(values: Array<string | undefined | null>): string[] {
  const set = new Set<string>()
  for (const rawValue of values) {
    const raw = String(rawValue || '').trim()
    if (!raw) continue
    set.add(raw)
  }
  return Array.from(set)
}

/**
 * 根据用户偏好获取显示名称
 */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return c
    }
  })
}

export function getVirtualScrollScript(): string {
  return `
    class ChunkedRenderer {
      constructor(container, data, renderItem) {
        this.container = container;
        this.data = data;
        this.renderItem = renderItem;
        this.batchSize = 100;
        this.rendered = 0;
        this.loading = false;

        this.list = document.createElement('div');
        this.list.className = 'message-list';
        this.container.appendChild(this.list);

        this.sentinel = document.createElement('div');
        this.sentinel.className = 'load-sentinel';
        this.container.appendChild(this.sentinel);

        this.renderBatch();

        this.observer = new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting && !this.loading) {
            this.renderBatch();
          }
        }, { root: this.container, rootMargin: '600px' });
        this.observer.observe(this.sentinel);
      }

      renderBatch() {
        if (this.rendered >= this.data.length) return;
        this.loading = true;
        const end = Math.min(this.rendered + this.batchSize, this.data.length);
        const fragment = document.createDocumentFragment();
        for (let i = this.rendered; i < end; i++) {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = this.renderItem(this.data[i], i);
          if (wrapper.firstElementChild) fragment.appendChild(wrapper.firstElementChild);
        }
        this.list.appendChild(fragment);
        this.rendered = end;
        this.loading = false;
      }

      setData(newData) {
        this.data = newData;
        this.rendered = 0;
        this.list.innerHTML = '';
        this.container.scrollTop = 0;
        if (this.data.length === 0) {
          this.list.innerHTML = '<div class="empty">暂无消息</div>';
          return;
        }
        this.renderBatch();
      }

      scrollToTime(timestamp) {
        const idx = this.data.findIndex(item => item.t >= timestamp);
        if (idx === -1) return;
        // Ensure all messages up to target are rendered
        while (this.rendered <= idx) {
          this.renderBatch();
        }
        const el = this.list.children[idx];
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('highlight');
          setTimeout(() => el.classList.remove('highlight'), 2500);
        }
      }

      scrollToIndex(index) {
        while (this.rendered <= index) {
          this.renderBatch();
        }
        const el = this.list.children[index];
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  `;
}

/**
 * 导出单个会话为 HTML 格式
 */

export function getClampedConcurrency(value: number | undefined, fallback = 2, max = 6): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const raw = Math.floor(value)
  return Math.max(1, Math.min(raw, max))
}

export function createProgressEmitter(onProgress?: (progress: ExportProgress) => void): {
  emit: (progress: ExportProgress, options?: { force?: boolean }) => void
  flush: () => void
} {
  if (!onProgress) {
    return {
      emit: () => { /* noop */ },
      flush: () => { /* noop */ }
    }
  }

  let pending: ExportProgress | null = null
  let lastSentAt = 0
  let lastPhase = ''
  let lastSessionId = ''
  let lastCollected = 0
  let lastExported = 0
  const MIN_PROGRESS_EMIT_INTERVAL_MS = 400
  const MESSAGE_PROGRESS_DELTA_THRESHOLD = 1200

  const commit = (progress: ExportProgress) => {
    onProgress(progress)
    pending = null
    lastSentAt = Date.now()
    lastPhase = String(progress.phase || '')
    lastSessionId = String(progress.currentSessionId || '')
    lastCollected = Number.isFinite(progress.collectedMessages) ? Math.max(0, Math.floor(progress.collectedMessages || 0)) : lastCollected
    lastExported = Number.isFinite(progress.exportedMessages) ? Math.max(0, Math.floor(progress.exportedMessages || 0)) : lastExported
  }

  const emit = (progress: ExportProgress, options?: { force?: boolean }) => {
    pending = progress
    const force = options?.force === true
    const now = Date.now()
    const phase = String(progress.phase || '')
    const sessionId = String(progress.currentSessionId || '')
    const collected = Number.isFinite(progress.collectedMessages) ? Math.max(0, Math.floor(progress.collectedMessages || 0)) : lastCollected
    const exported = Number.isFinite(progress.exportedMessages) ? Math.max(0, Math.floor(progress.exportedMessages || 0)) : lastExported
    const collectedDelta = Math.abs(collected - lastCollected)
    const exportedDelta = Math.abs(exported - lastExported)
    const shouldEmit = force ||
      phase !== lastPhase ||
      sessionId !== lastSessionId ||
      collectedDelta >= MESSAGE_PROGRESS_DELTA_THRESHOLD ||
      exportedDelta >= MESSAGE_PROGRESS_DELTA_THRESHOLD ||
      (now - lastSentAt >= MIN_PROGRESS_EMIT_INTERVAL_MS)

    if (shouldEmit && pending) {
      commit(pending)
    }
  }

  const flush = () => {
    if (!pending) return
    commit(pending)
  }

  return { emit, flush }
}

export function isStopError(error: unknown): boolean {
  if (!error) return false
  if (typeof error === 'string') {
    return error.includes(STOP_ERROR_CODE) || error.includes('导出任务已停止')
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code
    return code === STOP_ERROR_CODE || error.message.includes(STOP_ERROR_CODE) || error.message.includes('导出任务已停止')
  }
  return false
}

export function isPauseError(error: unknown): boolean {
  if (!error) return false
  if (typeof error === 'string') {
    return error.includes(PAUSE_ERROR_CODE) || error.includes('导出任务已暂停')
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code
    return code === PAUSE_ERROR_CODE || error.message.includes(PAUSE_ERROR_CODE) || error.message.includes('导出任务已暂停')
  }
  return false
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function copyFileOptimized(sourcePath: string, destPath: string): Promise<{ success: boolean; code?: string }> {
  const cloneFlag = typeof fs.constants.COPYFILE_FICLONE === 'number' ? fs.constants.COPYFILE_FICLONE : 0
  try {
    if (cloneFlag) {
      await fs.promises.copyFile(sourcePath, destPath, cloneFlag)
    } else {
      await fs.promises.copyFile(sourcePath, destPath)
    }
    return { success: true }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    if (!isCloneUnsupportedError(code)) {
      return { success: false, code }
    }
  }

  try {
    await fs.promises.copyFile(sourcePath, destPath)
    return { success: true }
  } catch (e) {
    return { success: false, code: (e as NodeJS.ErrnoException | undefined)?.code }
  }
}

