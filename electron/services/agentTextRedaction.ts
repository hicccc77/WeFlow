export type AgentSensitiveTextKind = 'phone' | 'identity-card'

export interface AgentSensitiveTextMatch {
  kind: AgentSensitiveTextKind
  start: number
  end: number
  normalized: string
  original: string
}

export interface AgentTextRedactionSummary {
  phoneMatches: number
  identityCardMatches: number
  uniquePhones: number
  uniqueIdentityCards: number
}

const VALID_REGION_PREFIXES = new Set([
  '11', '12', '13', '14', '15',
  '21', '22', '23',
  '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46',
  '50', '51', '52', '53', '54',
  '61', '62', '63', '64', '65',
  '71', '81', '82',
])
const IDENTITY_CONTEXT = /身份证|公民身份(?:号码)?|身份号码|证件号|证件号码/
const PHONE_CONTEXT = /手机(?:号|号码)?|联系电话|电话|联系方式|联系人|联系|拨打|打给|来电|回电|加(?:我|下)?好友|同号|contact\s*phone|主卡号码|入网|收件人|寄件人|预留(?:电话|号码)|客服热线|服务热线|热线|预约|报名/i
const NON_PHONE_CONTEXT = /订单(?:号|号码)?|快递单号|运单号|物流(?:号|编号)|流水号|编号|序列号|设备号|商品号|票号|卡号|账号|群号|qq号|验证码|取件码|身份证(?:号|号码)?|时间戳|发票号|合同号|工单号/i
const IDENTITY_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const IDENTITY_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']

export function normalizeAgentSensitiveText(value: string): string {
  return String(value || '')
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[ｘＸ]/g, (letter) => letter === 'Ｘ' ? 'X' : 'x')
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  const currentYear = new Date().getFullYear()
  if (year < 1800 || year > currentYear || month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getTime() <= Date.now()
}

function hasValidIdentityRegion(value: string): boolean {
  return VALID_REGION_PREFIXES.has(value.slice(0, 2)) && value.slice(0, 6) !== '000000'
}

export function isValidChineseIdentityCard18(value: string): boolean {
  const normalized = normalizeAgentSensitiveText(value).toUpperCase()
  if (!/^\d{17}[\dX]$/.test(normalized)) return false
  if (!hasValidIdentityRegion(normalized)) return false
  const year = Number(normalized.slice(6, 10))
  const month = Number(normalized.slice(10, 12))
  const day = Number(normalized.slice(12, 14))
  if (!isValidCalendarDate(year, month, day)) return false
  if (normalized.slice(14, 17) === '000') return false
  const sum = IDENTITY_WEIGHTS.reduce((total, weight, index) => total + Number(normalized[index]) * weight, 0)
  return IDENTITY_CHECK_CODES[sum % 11] === normalized[17]
}

function isValidChineseIdentityCard15(value: string): boolean {
  const normalized = normalizeAgentSensitiveText(value)
  if (!/^\d{15}$/.test(normalized) || !hasValidIdentityRegion(normalized)) return false
  const year = 1900 + Number(normalized.slice(6, 8))
  const month = Number(normalized.slice(8, 10))
  const day = Number(normalized.slice(10, 12))
  return isValidCalendarDate(year, month, day) && normalized.slice(12, 15) !== '000'
}

export function findChineseMobileCandidates(value: string): AgentSensitiveTextMatch[] {
  const originalText = String(value || '')
  const normalizedText = normalizeAgentSensitiveText(originalText)
  const matches: AgentSensitiveTextMatch[] = []
  const pattern = /(?<!\d)1[3-9]\d{9}(?!\d)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(normalizedText)) !== null) {
    matches.push({
      kind: 'phone',
      start: match.index,
      end: match.index + match[0].length,
      normalized: match[0],
      original: originalText.slice(match.index, match.index + match[0].length),
    })
  }
  return matches
}

export function findChineseIdentityCardCandidates(value: string): AgentSensitiveTextMatch[] {
  const originalText = String(value || '')
  const normalizedText = normalizeAgentSensitiveText(originalText)
  const matches: AgentSensitiveTextMatch[] = []
  const pattern18 = /(?<!\d)\d{17}[\dXx](?![\dXx])/g
  let match: RegExpExecArray | null
  while ((match = pattern18.exec(normalizedText)) !== null) {
    if (!isValidChineseIdentityCard18(match[0])) continue
    matches.push({
      kind: 'identity-card',
      start: match.index,
      end: match.index + match[0].length,
      normalized: match[0].toUpperCase(),
      original: originalText.slice(match.index, match.index + match[0].length),
    })
  }

  const pattern15 = /(?<!\d)\d{15}(?!\d)/g
  while ((match = pattern15.exec(normalizedText)) !== null) {
    const context = normalizedText.slice(Math.max(0, match.index - 16), Math.min(normalizedText.length, match.index + match[0].length + 16))
    if (!IDENTITY_CONTEXT.test(context) || !isValidChineseIdentityCard15(match[0])) continue
    matches.push({
      kind: 'identity-card',
      start: match.index,
      end: match.index + match[0].length,
      normalized: match[0],
      original: originalText.slice(match.index, match.index + match[0].length),
    })
  }
  return matches
}

export function findAgentSensitiveTextMatches(value: string): AgentSensitiveTextMatch[] {
  const normalizedText = normalizeAgentSensitiveText(value)
  const candidates = [
    ...findChineseIdentityCardCandidates(value),
    ...findChineseMobileCandidates(value).filter((candidate) => {
      const context = normalizedText.slice(
        Math.max(0, candidate.start - 28),
        Math.min(normalizedText.length, candidate.end + 28),
      )
      const hasPhoneContext = PHONE_CONTEXT.test(context)
      const hasNonPhoneContext = NON_PHONE_CONTEXT.test(context)
      // 明确的手机号语境始终保留候选；明确属于订单号、日期等非手机号语境时排除。
      // 没有上下文提示时采取保守脱敏，避免真实手机号漏出。
      return hasPhoneContext || !hasNonPhoneContext
    }),
  ].sort((left, right) => left.start - right.start || right.end - right.start - (left.end - left.start))
  const accepted: AgentSensitiveTextMatch[] = []
  for (const candidate of candidates) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue
    accepted.push(candidate)
  }
  return accepted.sort((left, right) => left.start - right.start)
}

function isBinaryLike(value: unknown): boolean {
  return Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer
}

export class AgentTextRedactionSession {
  private readonly valueToToken = new Map<string, string>()
  private readonly tokenToOriginal = new Map<string, string>()
  private phoneMatches = 0
  private identityCardMatches = 0
  private phoneSequence = 0
  private identityCardSequence = 0

  private tokenFor(match: AgentSensitiveTextMatch): string {
    const key = `${match.kind}:${match.normalized}`
    const previous = this.valueToToken.get(key)
    if (previous) return previous
    const sequence = match.kind === 'phone' ? ++this.phoneSequence : ++this.identityCardSequence
    const label = match.kind === 'phone' ? '手机号' : '身份证'
    const token = `【${label}#${sequence}】`
    this.valueToToken.set(key, token)
    this.tokenToOriginal.set(token, match.original)
    return token
  }

  redactText(value: string): string {
    const source = String(value || '')
    const matches = findAgentSensitiveTextMatches(source)
    if (matches.length === 0) return source
    let result = ''
    let cursor = 0
    for (const match of matches) {
      result += source.slice(cursor, match.start)
      result += this.tokenFor(match)
      cursor = match.end
      if (match.kind === 'phone') this.phoneMatches += 1
      else this.identityCardMatches += 1
    }
    return result + source.slice(cursor)
  }

  restoreText(value: string): string {
    let result = String(value || '')
    for (const [token, original] of this.tokenToOriginal.entries()) {
      if (result.includes(token)) result = result.split(token).join(original)
    }
    return result
  }

  redactValue<T>(value: T): T {
    return this.transformValue(value, (text) => this.redactText(text), new WeakMap())
  }

  restoreValue<T>(value: T): T {
    return this.transformValue(value, (text) => this.restoreText(text), new WeakMap())
  }

  summary(): AgentTextRedactionSummary {
    return {
      phoneMatches: this.phoneMatches,
      identityCardMatches: this.identityCardMatches,
      uniquePhones: this.phoneSequence,
      uniqueIdentityCards: this.identityCardSequence,
    }
  }

  private transformValue<T>(value: T, transformText: (value: string) => string, seen: WeakMap<object, unknown>): T {
    if (typeof value === 'string') return transformText(value) as T
    if (value === null || typeof value !== 'object' || isBinaryLike(value) || value instanceof Date) return value
    const source = value as object
    const previous = seen.get(source)
    if (previous) return previous as T
    if (Array.isArray(value)) {
      const result: unknown[] = []
      seen.set(source, result)
      value.forEach((item) => result.push(this.transformValue(item, transformText, seen)))
      return result as T
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    const result: Record<string, unknown> = {}
    seen.set(source, result)
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = this.transformValue(nested, transformText, seen)
    }
    return result as T
  }
}

export function createAgentTextRedactionSession(): AgentTextRedactionSession {
  return new AgentTextRedactionSession()
}

export function redactAgentTextForLog(value: string): string {
  const session = createAgentTextRedactionSession()
  return session.redactText(value)
    .replace(/【手机号#\d+】/g, '【手机号】')
    .replace(/【身份证#\d+】/g, '【身份证】')
}

export function redactAgentValueForLog<T>(value: T): T {
  const session = createAgentTextRedactionSession()
  const redacted = session.redactValue(value)
  const collapse = (nested: unknown, seen = new WeakSet<object>()): unknown => {
    if (typeof nested === 'string') {
      return nested
        .replace(/【手机号#\d+】/g, '【手机号】')
        .replace(/【身份证#\d+】/g, '【身份证】')
    }
    if (nested === null || typeof nested !== 'object' || isBinaryLike(nested) || nested instanceof Date) return nested
    if (seen.has(nested)) return nested
    seen.add(nested)
    if (Array.isArray(nested)) return nested.map((item) => collapse(item, seen))
    const prototype = Object.getPrototypeOf(nested)
    if (prototype !== Object.prototype && prototype !== null) return nested
    return Object.fromEntries(Object.entries(nested).map(([key, item]) => [key, collapse(item, seen)]))
  }
  return collapse(redacted) as T
}
