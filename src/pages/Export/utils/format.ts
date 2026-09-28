/**
 * ExportV2 — Formatting utilities
 * Pure functions for date, time, duration, and path formatting.
 */

// ─── Duration ────────────────────────────────────────────────

export const formatDurationMs = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}

// ─── Absolute dates ──────────────────────────────────────────

export const formatAbsoluteDate = (timestamp: number): string => {
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const formatYmdDateFromSeconds = (timestamp?: number): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp * 1000)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const formatYmdHmDateTime = (timestamp?: number): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  const h = `${d.getHours()}`.padStart(2, '0')
  const min = `${d.getMinutes()}`.padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

// ─── Relative time ───────────────────────────────────────────

export const formatLatestMessageTimeFromSeconds = (
  timestamp?: number,
  now: number = Date.now()
): { text: string; title: string } => {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
    return { text: '--', title: '' }
  }
  const ms = timestamp * 1000
  const absolute = formatYmdHmDateTime(ms)
  const diff = Math.max(0, now - ms)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return { text: '刚刚', title: absolute }
  if (diff < hour) {
    const minutes = Math.max(1, Math.floor(diff / minute))
    return { text: `${minutes} 分钟前`, title: absolute }
  }
  if (diff < day) {
    const hours = Math.max(1, Math.floor(diff / hour))
    return { text: `${hours} 小时前`, title: absolute }
  }
  return { text: absolute, title: absolute }
}

export const formatRecentExportTime = (timestamp?: number, now = Date.now()): string => {
  if (!timestamp) return ''
  const diff = Math.max(0, now - timestamp)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) {
    const minutes = Math.max(1, Math.floor(diff / minute))
    return `${minutes} 分钟前`
  }
  if (diff < day) {
    const hours = Math.max(1, Math.floor(diff / hour))
    return `${hours} 小时前`
  }
  return formatAbsoluteDate(timestamp)
}

// ─── Path formatting ─────────────────────────────────────────

export const formatPathBrief = (value: string, maxLength = 52): string => {
  const normalized = String(value || '')
  if (normalized.length <= maxLength) return normalized

  // Try to split by path separator
  const separator = normalized.includes('\\') ? '\\' : '/'
  const parts = normalized.split(separator).filter(Boolean) // Handle trailing/leading slashes
  
  if (parts.length <= 2) {
    // Cannot shorten by directory levels, fallback to string slice
    const headLength = Math.max(10, Math.floor(maxLength * 0.55))
    const tailLength = Math.max(8, maxLength - headLength - 1)
    return `${normalized.slice(0, headLength)}…${normalized.slice(-tailLength)}`
  }

  // Handle Windows paths like C:\ keeping the root
  let first = parts[0]
  if (normalized.startsWith(separator)) {
      first = separator + first
  } else if (normalized.includes(':\\') || normalized.includes(':/')) {
      // Keep root drive like C:
      first = first + separator
  } else {
      first = first + separator
  }

  const last = parts[parts.length - 1]
  
  let result = `${first}…${separator}${last}`
  let leftIdx = 1
  let rightIdx = parts.length - 2
  
  while (leftIdx <= rightIdx) {
    const nextLeft = `${parts[leftIdx]}${separator}`
    const nextRight = leftIdx < rightIdx ? `${separator}${parts[rightIdx]}` : ''
    
    if (result.length + nextLeft.length + nextRight.length <= maxLength) {
      result = result.replace('…', `${nextLeft}…${nextRight}`)
      leftIdx++
      rightIdx--
    } else {
      break
    }
  }

  if (result.length > maxLength) {
    const headLength = Math.max(10, Math.floor(maxLength * 0.55))
    const tailLength = Math.max(8, maxLength - headLength - 1)
    return `${normalized.slice(0, headLength)}…${normalized.slice(-tailLength)}`
  }

  return result
}

export const resolveParentDir = (value: string): string => {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const noTrailing = normalized.replace(/[\\/]+$/, '')
  if (!noTrailing) return normalized
  const lastSlash = Math.max(noTrailing.lastIndexOf('/'), noTrailing.lastIndexOf('\\'))
  if (lastSlash < 0) return normalized
  if (lastSlash === 0) return noTrailing.slice(0, 1)
  if (/^[A-Za-z]:$/.test(noTrailing.slice(0, lastSlash))) {
    return `${noTrailing.slice(0, lastSlash)}\\`
  }
  return noTrailing.slice(0, lastSlash)
}

// ─── Avatar ──────────────────────────────────────────────────

export const getAvatarLetter = (name: string): string => {
  if (!name) return '?'
  return [...name][0] || '?'
}

// ─── DateTime local value (for <input type="datetime-local">) ─

export const toDateTimeLocalValue = (timestamp: number): string => {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

export const parseDateTimeLocalValue = (value: string): number | null => {
  const text = String(value || '').trim()
  if (!text) return null
  const parsed = new Date(text)
  const timestamp = parsed.getTime()
  if (!Number.isFinite(timestamp)) return null
  return Math.floor(timestamp)
}

// ─── Number normalization ────────────────────────────────────

export const normalizeMessageCount = (value: unknown): number | undefined => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.floor(parsed)
}

export const normalizeTimestampSeconds = (value: unknown): number | undefined => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

export const mergeStableCount = (incoming: number | undefined, previous: number | undefined): number | undefined => {
  if (typeof incoming !== 'number') return previous
  if (incoming === 0 && typeof previous === 'number' && previous > 0) return previous
  return incoming
}
