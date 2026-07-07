export function normalizeDisplayNameValue(value?: unknown): string | undefined {
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return undefined
    const converted = String(value)
    return converted.length > 0 ? converted.trim() || converted : undefined
  }

  if (value.length === 0) return undefined

  const trimmed = value.trim()
  if (!trimmed) return value

  const lower = trimmed.toLowerCase()
  if (
    trimmed === '未知' ||
    lower === 'unknown' ||
    lower === 'null' ||
    lower === 'undefined' ||
    trimmed === '微信用户' ||
    trimmed === '用户' ||
    lower === 'wechat user' ||
    lower.startsWith('unknown_sender_')
  ) {
    return undefined
  }

  return trimmed
}

export function pickDisplayName(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const normalized = normalizeDisplayNameValue(value)
    if (normalized !== undefined) return normalized
  }
  return undefined
}

export function displayNameOrFallback(fallback: string, ...values: Array<unknown>): string {
  return pickDisplayName(...values) ?? fallback
}

export function displayNameForCompare(value?: unknown): string {
  return normalizeDisplayNameValue(value)?.trim().toLowerCase() || ''
}
