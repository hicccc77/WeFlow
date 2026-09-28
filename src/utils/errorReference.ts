export const extractErrorCodes = (value: unknown): number[] => {
  const text = value instanceof Error
    ? value.message
    : typeof value === 'object' && value && 'message' in value
      ? String((value as { message?: unknown }).message || '')
      : String(value || '')
  const matches = text.match(/-\d{1,6}/g) || []
  return Array.from(new Set(matches.map(Number).filter(Number.isFinite)))
}

export const normalizeErrorReferenceQuery = (value: unknown): string => {
  const text = value instanceof Error
    ? value.message
    : typeof value === 'object' && value && 'message' in value
      ? String((value as { message?: unknown }).message || '')
      : String(value || '')
  const code = extractErrorCodes(text)[0]
  return code !== undefined ? String(code) : text.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export const openErrorReferenceWindow = (value?: unknown): Promise<boolean> => {
  const query = normalizeErrorReferenceQuery(value)
  return window.electronAPI.window.openErrorReferenceWindow(query || undefined)
}
