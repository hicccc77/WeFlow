import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

export async function getMediaFileStat(sourcePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.promises.stat(sourcePath)
    if (!stat.isFile()) return null
    return {
      size: Number.isFinite(stat.size) ? Math.max(0, Math.floor(stat.size)) : 0,
      mtimeMs: Number.isFinite(stat.mtimeMs) ? Math.max(0, Math.floor(stat.mtimeMs)) : 0
    }
  } catch {
    return null
  }
}

export function buildMediaFileCachePath(
  cacheRoot: string,
  kind: 'image' | 'video' | 'emoji',
  sourcePath: string,
  fileStat: { size: number; mtimeMs: number }
): string {
  const normalizedSource = path.resolve(sourcePath)
  const rawKey = `${kind}\u001f${normalizedSource}\u001f${fileStat.size}\u001f${fileStat.mtimeMs}`
  const digest = crypto.createHash('sha1').update(rawKey).digest('hex')
  const ext = path.extname(normalizedSource) || ''
  return path.join(cacheRoot, kind, digest.slice(0, 2), `${digest}${ext}`)
}
