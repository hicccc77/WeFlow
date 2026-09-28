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

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

export function formatIsoTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString()
}

export function parseCompactDateTimeDigitsToSeconds(digits: string): number {
  if (digits.length < 14) return 0
  const year = parseInt(digits.substring(0, 4), 10)
  const month = parseInt(digits.substring(4, 6), 10) - 1
  const day = parseInt(digits.substring(6, 8), 10)
  const hours = parseInt(digits.substring(8, 10), 10)
  const minutes = parseInt(digits.substring(10, 12), 10)
  const seconds = parseInt(digits.substring(12, 14), 10)
  const date = new Date(year, month, day, hours, minutes, seconds)
  if (isNaN(date.getTime())) return 0
  return Math.floor(date.getTime() / 1000)
}

export function parseDateTimeTextToSeconds(text: string): number {
  if (!text) return 0
  const digits = text.replace(/\D/g, '')
  return parseCompactDateTimeDigitsToSeconds(digits)
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

export function normalizeRowTimestampSeconds(value: unknown): number {
  return normalizeTimestampSeconds(value)
}

export function getTimestampSecondsFromRow(row: any): number {
  if (!row) return 0
  const raw = row.create_time ?? row.createTime ?? row.CreateTime ?? row.msgCreateTime ?? row.msg_create_time ?? row.timestamp ?? row.Timestamp
  if (raw !== undefined && raw !== null) {
    return normalizeTimestampSeconds(raw)
  }
  return 0
}
