import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { normalizeTimestampSeconds } from './timestamp'
import { ExportOptions } from '../types'

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

export function normalizeExportConflictStrategy(value: unknown): 'incremental' | 'overwrite' | 'rename' {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'overwrite') return 'overwrite'
  if (normalized === 'rename') return 'rename'
  return 'incremental'
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
  // 昵称并不唯一，且清理非法字符后不同昵称/会话也可能得到同一个文件名。
  // 稳定的会话短指纹可防止批量导出时互相覆盖，同时不暴露完整会话 ID。
  const sessionFingerprint = crypto.createHash('sha256').update(String(sessionId || ''), 'utf8').digest('hex').slice(0, 10)
  const parts = [`${baseName}-${sessionFingerprint}`]
  if (suffix) parts.push(suffix)
  if (namingMode === 'date-range') {
    parts.push(buildDateRangeFileNamePart(options.dateRange))
  }
  return sanitizeExportFileNamePart(parts.join('_')) || 'session'
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

export async function reserveUniqueOutputPath(preferredPath: string, reservedPaths: Set<string>): Promise<string> {
  const dir = path.dirname(preferredPath)
  const ext = path.extname(preferredPath)
  const base = path.basename(preferredPath, ext)

  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const candidate = attempt === 0
      ? preferredPath
      : path.join(dir, `${base}_${attempt + 1}${ext}`)

    if (reservedPaths.has(candidate)) continue

    const exists = await pathExists(candidate)
    if (reservedPaths.has(candidate)) continue
    if (exists) continue

    reservedPaths.add(candidate)
    return candidate
  }

  const fallback = path.join(dir, `${base}_${Date.now()}${ext}`)
  reservedPaths.add(fallback)
  return fallback
}
