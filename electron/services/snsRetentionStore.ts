import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SnsPost } from './snsService'

export const SNS_RETENTION_MAX_BYTES = 128 * 1024 * 1024
export const snsRetentionAccountHash = (value: string): string => createHash('sha256').update(value).digest('hex')
const hash = snsRetentionAccountHash
export interface RetainedSnsMedia {
  id: string; mediaIndex: number; kind: 'image' | 'video' | 'livephoto'; localPath?: string; thumbnailPath?: string
  status: 'pending' | 'saved' | 'failed' | 'blocked'; quality: 'original' | 'thumbnail' | 'none'
  contentType?: string; bytes?: number; error?: string
}
export interface RetainedSnsPost {
  id: string; username: string; nickname: string; createTime: number; contentDesc: string; type?: number
  likes: string[]; comments: SnsPost['comments']; location?: SnsPost['location']; linkTitle?: string; linkUrl?: string
  capturedAt: number; lastSeenAt: number; snapshotCount: number; media: RetainedSnsMedia[]
}
export interface SnsRetentionListOptions { query?: string; username?: string; limit?: number; offset?: number }
export interface SnsMediaJob extends RetainedSnsMedia {
  postId: string; sourceUrl: string; thumbUrl: string; key: string; attempts: number
}
const finite = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0
const stringId = (value: unknown): string => typeof value === 'string' ? value.trim()
  : typeof value === 'bigint' ? value.toString() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : ''
const json = (value: unknown): string => JSON.stringify(value)
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => json(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}'
  return json(value) || 'null'
}
function stableUrl(value: string): string {
  try { const url = new URL(value); url.searchParams.delete('token'); url.searchParams.delete('idx'); return url.toString() } catch { return value }
}
function mediaKind(post: SnsPost, url: string): 'image' | 'video' {
  if (post.type === 15) return 'video'
  try {
    const pathname = new URL(url).pathname
    if (/\.(?:mp4|m4v|mov)$/i.test(pathname) || /(?:^|\/)(?:video|snsvideo)(?:\/|$)/i.test(pathname)) return 'video'
  } catch { /* A local cache path is classified by its extension below. */ }
  return /\.(?:mp4|m4v|mov)$/i.test(url) ? 'video' : 'image'
}
function normalized(post: SnsPost): SnsPost | null {
  const id = stringId(post.id)
  if (!id) return null
  return { ...post, id, tid: stringId(post.tid) || undefined, username: String(post.username || ''), nickname: String(post.nickname || ''),
    createTime: finite(post.createTime), contentDesc: String(post.contentDesc || ''),
    media: Array.isArray(post.media) ? post.media : [], likes: Array.isArray(post.likes) ? post.likes.map(String) : [],
    comments: Array.isArray(post.comments) ? post.comments.map(comment => ({ ...comment, id: stringId(comment.id), refCommentId: stringId(comment.refCommentId), nickname: String(comment.nickname || ''), content: String(comment.content || '') })) : [] }
}
function mergePosts(previous: SnsPost, observed: SnsPost): SnsPost {
  const comments = new Map(previous.comments.map(comment => [comment.id || hash(stable(comment)), comment]))
  for (const comment of observed.comments) {
    const key = comment.id || hash(stable(comment)); const old = comments.get(key)
    comments.set(key, { ...old, ...comment, content: comment.content || old?.content || '' })
  }
  // The current archive is a non-destructive view; exact observations remain in snapshots.
  return { ...previous, ...observed, contentDesc: observed.contentDesc || previous.contentDesc,
    createTime: observed.createTime || previous.createTime, type: observed.type ?? previous.type,
    nickname: observed.nickname || previous.nickname, username: observed.username || previous.username,
    rawXml: observed.rawXml || previous.rawXml, linkTitle: observed.linkTitle || previous.linkTitle,
    linkUrl: observed.linkUrl || previous.linkUrl, location: observed.location || previous.location,
    media: observed.media.length ? observed.media : previous.media,
    likes: [...new Set([...previous.likes, ...observed.likes])], comments: [...comments.values()] }
}
export function snsMediaSignature(header: Buffer): { contentType: string; extension: string } | null {
  if (header.length >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255) return { contentType: 'image/jpeg', extension: '.jpg' }
  if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { contentType: 'image/png', extension: '.png' }
  if (/^GIF8[79]a/.test(header.subarray(0, 6).toString('ascii'))) return { contentType: 'image/gif', extension: '.gif' }
  if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d) return { contentType: 'image/bmp', extension: '.bmp' }
  if (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP') return { contentType: 'image/webp', extension: '.webp' }
  if (header.length >= 12 && header.subarray(4, 8).toString() === 'ftyp') {
    const brand = header.subarray(8, 12).toString()
    if (['avif', 'avis'].includes(brand)) return { contentType: 'image/avif', extension: '.avif' }
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return { contentType: 'image/heic', extension: '.heic' }
    if (['isom', 'iso2', 'mp41', 'mp42', 'M4V ', 'qt  ', 'avc1', 'dash', 'msdh', 'MSNV'].includes(brand)) return { contentType: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4', extension: brand === 'qt  ' ? '.mov' : '.mp4' }
  }
  return null
}

/** Persistent independent copies of visible Moments data. There is no TTL or source deletion propagation. */
export class SnsRetentionStore {
  readonly directory: string
  readonly archivePath: string
  private db: DatabaseSync
  private closed = false
  constructor(userData: string, identity: string) {
    if (!identity.trim()) throw new Error('未选择朋友圈留存账号')
    const root = join(userData, 'SnsRetention')
    this.directory = join(root, hash(identity))
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700)
    this.archivePath = join(this.directory, 'posts.sqlite')
    this.db = new DatabaseSync(this.archivePath); chmodSync(this.archivePath, 0o600)
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, username TEXT NOT NULL,nickname TEXT NOT NULL,contentDesc TEXT NOT NULL,
        createTime INTEGER NOT NULL,mergedJson TEXT NOT NULL,capturedAt INTEGER NOT NULL,lastSeenAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(postId TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,observedAt INTEGER NOT NULL,PRIMARY KEY(postId,hash));
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,postId TEXT NOT NULL,mediaIndex INTEGER NOT NULL,kind TEXT NOT NULL,
        sourceUrl TEXT NOT NULL,thumbUrl TEXT NOT NULL,key TEXT NOT NULL,localPath TEXT,thumbnailPath TEXT,status TEXT NOT NULL DEFAULT 'pending',
        quality TEXT NOT NULL DEFAULT 'none',contentType TEXT,bytes INTEGER,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,retryAfter INTEGER NOT NULL DEFAULT 0,priorityUntil INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS sns_post_time ON posts(createTime DESC);
      CREATE INDEX IF NOT EXISTS sns_media_post ON media(postId);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
    if (!this.db.prepare('PRAGMA table_info(media)').all().some(column => column.name === 'priorityUntil')) {
      this.db.exec('ALTER TABLE media ADD COLUMN priorityUntil INTEGER NOT NULL DEFAULT 0')
    }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  capturePosts(input: SnsPost[], now = Date.now()): void {
    if (this.closed || !input.length) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const value of input) {
        const post = normalized(value); if (!post) continue
        const previous = this.db.prepare('SELECT mergedJson FROM posts WHERE id=?').get(post.id)
        const merged = previous ? mergePosts(JSON.parse(String(previous.mergedJson)), post) : post
        this.db.prepare(`INSERT INTO posts(id,username,nickname,contentDesc,createTime,mergedJson,capturedAt,lastSeenAt) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET username=excluded.username,nickname=excluded.nickname,contentDesc=excluded.contentDesc,createTime=excluded.createTime,mergedJson=excluded.mergedJson,lastSeenAt=excluded.lastSeenAt`).run(
          post.id, merged.username, merged.nickname, merged.contentDesc, merged.createTime, json(merged), now, now)
        this.db.prepare('INSERT OR IGNORE INTO snapshots(postId,hash,json,observedAt) VALUES(?,?,?,?)').run(post.id, hash(stable(post)), json(post), now)
        post.media.forEach((media, index) => {
          this.captureMedia(post, index, mediaKind(post, media.url || ''), media)
          if (media.livePhoto) this.captureMedia(post, index, 'livephoto', media.livePhoto)
        })
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private captureMedia(post: SnsPost, mediaIndex: number, kind: RetainedSnsMedia['kind'], input: { url: string; thumb: string; key?: string; md5?: string }): void {
    const sourceUrl = String(input.url || ''); const thumbUrl = String(input.thumb || '')
    if (!sourceUrl && !thumbUrl) return
    const key = typeof input.key === 'string' ? input.key : typeof input.key === 'number' && Number.isSafeInteger(input.key) ? String(input.key) : ''
    const id = hash(post.id + '\0' + kind + '\0' + (input.md5 || stableUrl(sourceUrl || thumbUrl)))
    const old = this.db.prepare('SELECT * FROM media WHERE id=?').get(id)
    if (!old) {
      this.db.prepare('INSERT INTO media(id,postId,mediaIndex,kind,sourceUrl,thumbUrl,key) VALUES(?,?,?,?,?,?,?)').run(id, post.id, mediaIndex, kind, sourceUrl, thumbUrl, key)
    } else {
      const changed = (sourceUrl && sourceUrl !== old.sourceUrl) || (thumbUrl && thumbUrl !== old.thumbUrl) || (key && key !== old.key)
      const saved = old.status === 'saved' && old.quality === 'original'
      this.db.prepare('UPDATE media SET sourceUrl=?,thumbUrl=?,key=?,mediaIndex=? WHERE id=?').run(sourceUrl || String(old.sourceUrl), thumbUrl || String(old.thumbUrl), key || String(old.key), mediaIndex, id)
      if (changed && !saved) this.db.prepare("UPDATE media SET status='pending',attempts=0,retryAfter=0,error=NULL WHERE id=?").run(id)
    }
  }
  private mediaRow(row: Record<string, unknown>): RetainedSnsMedia {
    return { id: String(row.id), mediaIndex: finite(row.mediaIndex), kind: String(row.kind) as RetainedSnsMedia['kind'],
      localPath: row.localPath ? String(row.localPath) : undefined, thumbnailPath: row.thumbnailPath ? String(row.thumbnailPath) : undefined,
      status: String(row.status) as RetainedSnsMedia['status'], quality: String(row.quality) as RetainedSnsMedia['quality'],
      contentType: row.contentType ? String(row.contentType) : undefined, bytes: row.bytes ? finite(row.bytes) : undefined, error: row.error ? String(row.error) : undefined }
  }
  list(options: SnsRetentionListOptions = {}): { items: RetainedSnsPost[]; total: number } {
    const clauses: string[] = []; const args: string[] = []
    if (options.username) { clauses.push('username=?'); args.push(options.username) }
    const query = String(options.query || '').trim().slice(0, 300)
    if (query) { clauses.push('(instr(contentDesc,?)>0 OR instr(nickname,?)>0)'); args.push(query, query) }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM posts' + where).get(...args)?.n || 0)
    const rows = this.db.prepare('SELECT * FROM posts' + where + ' ORDER BY createTime DESC,id LIMIT ? OFFSET ?').all(...args,
      Math.max(1, Math.min(100, Math.floor(finite(options.limit) || 30))), Math.max(0, Math.floor(finite(options.offset))))
    return { total, items: rows.map(row => {
      const post: SnsPost = JSON.parse(String(row.mergedJson))
      return { id: String(row.id), username: post.username, nickname: post.nickname, createTime: post.createTime,
        contentDesc: post.contentDesc, type: post.type, likes: post.likes, comments: post.comments, location: post.location,
        linkTitle: post.linkTitle, linkUrl: post.linkUrl, capturedAt: finite(row.capturedAt), lastSeenAt: finite(row.lastSeenAt),
        snapshotCount: Number(this.db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE postId=?').get(String(row.id))?.n || 0),
        media: this.db.prepare('SELECT * FROM media WHERE postId=? ORDER BY mediaIndex,kind').all(String(row.id)).map(media => this.mediaRow(media)) }
    }) }
  }
  stats(): { totalPosts: number; totalSnapshots: number; savedMedia: number; pendingMedia: number; failedMedia: number; lastScanAt: number | null; baselineComplete: boolean; baselineOffset: number } {
    const media = this.db.prepare("SELECT SUM(status='saved' AND quality='original') AS saved,SUM(status='pending') AS pending,SUM(status IN('failed','blocked') OR quality='thumbnail') AS failed FROM media").get()
    return { totalPosts: Number(this.db.prepare('SELECT COUNT(*) AS n FROM posts').get()?.n || 0),
      totalSnapshots: Number(this.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()?.n || 0),
      savedMedia: Number(media?.saved || 0), pendingMedia: Number(media?.pending || 0), failedMedia: Number(media?.failed || 0),
      lastScanAt: Number(this.meta('lastScanAt') || 0) || null, baselineComplete: this.meta('baselineComplete') === '1', baselineOffset: Number(this.meta('baselineOffset') || 0) }
  }
  private meta(key: string): string { return String(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value || '') }
  private setMeta(key: string, value: string): void { this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(key, value) }
  markScanned(now = Date.now()): void { if (!this.closed) this.setMeta('lastScanAt', String(now)) }
  setBaseline(offset: number, complete: boolean): void {
    if (!this.closed) { this.setMeta('baselineOffset', String(offset)); this.setMeta('baselineComplete', complete ? '1' : '0') }
  }
  retryFailed(): void { if (!this.closed) this.db.prepare("UPDATE media SET status='pending',attempts=0,retryAfter=0 WHERE status='failed' OR quality='thumbnail'").run() }
  prioritizePostIds(ids: string[], now = Date.now()): void {
    if (this.closed || !ids.length) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const statement = this.db.prepare("UPDATE media SET priorityUntil=MAX(priorityUntil,?) WHERE postId=? AND status='pending'")
      for (const id of new Set(ids.slice(0, 100))) statement.run(now + 60_000, id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  nextMedia(now = Date.now()): SnsMediaJob | null {
    if (this.closed) return null
    const row = this.db.prepare(`SELECT m.* FROM media m JOIN posts p ON p.id=m.postId
      WHERE (m.status='pending' OR (m.status='failed' OR m.quality='thumbnail') AND m.attempts<3) AND m.retryAfter<=?
      ORDER BY (m.priorityUntil>?) DESC,p.createTime DESC,m.mediaIndex,m.kind LIMIT 1`).get(now, now)
    if (row) this.db.prepare('UPDATE media SET retryAfter=? WHERE id=?').run(now + 60_000, String(row.id))
    return row ? { ...this.mediaRow(row), postId: String(row.postId), sourceUrl: String(row.sourceUrl), thumbUrl: String(row.thumbUrl), key: String(row.key), attempts: finite(row.attempts) } : null
  }
  deferMedia(id: string, error: string, blocked = false, now = Date.now()): void {
    if (this.closed) return
    // Preserve an existing thumbnail even when an upgrade attempt fails.
    this.db.prepare(`UPDATE media SET status=CASE WHEN quality='thumbnail' THEN 'saved' ELSE ? END,error=?,attempts=CASE WHEN ? THEN 3 ELSE attempts+1 END,retryAfter=? WHERE id=? AND quality!='original'`).run(
      blocked ? 'blocked' : 'failed', error.slice(0, 180), blocked ? 1 : 0, now + 5 * 60_000, id)
  }
  async saveMedia(id: string, input: { data?: Buffer; path?: string }, quality: 'original' | 'thumbnail'): Promise<void> {
    if (this.closed) return
    const row = this.db.prepare('SELECT * FROM media WHERE id=?').get(id)
    if (!row || (row.quality === 'original' && row.status === 'saved')) return
    let header: Buffer; let bytes: number
    if (input.path) {
      const handle = await fs.open(input.path, 'r')
      try { const info = await handle.stat(); bytes = info.size; header = Buffer.alloc(Math.min(32, bytes)); await handle.read(header, 0, header.length, 0) } finally { await handle.close() }
    } else { bytes = input.data?.length || 0; header = input.data?.subarray(0, 32) || Buffer.alloc(0) }
    if (bytes <= 0 || bytes > SNS_RETENTION_MAX_BYTES) throw new Error('媒体为空或超过128MiB留存上限')
    const signature = snsMediaSignature(header)
    if (!signature || (quality === 'thumbnail' && !signature.contentType.startsWith('image/')) ||
      (quality === 'original' && row.kind === 'image' && !signature.contentType.startsWith('image/')) ||
      (quality === 'original' && row.kind !== 'image' && !signature.contentType.startsWith('video/'))) throw new Error('媒体格式验证失败')
    const directory = join(this.directory, 'media'); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700)
    const destination = join(directory, id + '-' + quality + signature.extension)
    const temporary = destination + '.' + randomUUID() + '.tmp'
    try {
      if (input.path) await fs.copyFile(input.path, temporary); else await fs.writeFile(temporary, input.data!, { mode: 0o600 })
      const copied = await fs.stat(temporary); if (copied.size > SNS_RETENTION_MAX_BYTES) throw new Error('媒体超过128MiB留存上限')
      await fs.chmod(temporary, 0o600)
      if (this.closed) return
      await fs.rename(temporary, destination)
      if (this.closed) return
      this.db.prepare(`UPDATE media SET localPath=?,thumbnailPath=CASE WHEN ?='thumbnail' THEN ? ELSE thumbnailPath END,
        status='saved',quality=?,contentType=?,bytes=?,error=?,retryAfter=? WHERE id=? AND quality!='original'`).run(
        destination, quality, destination, quality, signature.contentType, copied.size,
        quality === 'thumbnail' ? '原媒体暂不可用，仅保留缩略图' : null, quality === 'thumbnail' ? Date.now() + 5 * 60_000 : 0, id)
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }
}
