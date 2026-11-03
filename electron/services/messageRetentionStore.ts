import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync, existsSync, promises as fs } from 'node:fs'
import { join, extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RetentionInput {
  messageKey?: string; localId: number; serverId?: number | string; serverIdRaw?: string
  localType: number; createTime: number; isSend: number | null; senderUsername?: string | null
  senderDisplayName?: string; parsedContent: string; rawContent?: string
  _db_path?: string; _db_name?: string; _table_name?: string
}
export interface RetainedMessage {
  id: string; sessionId: string; sessionName: string; senderName: string; content: string
  rawContent: string; createTime: number; localId: number; serverId: string; localType: number
  isSend: boolean; recalledAt: number | null; originalMissing: boolean; mediaPath?: string
  mediaState: 'none' | 'pending' | 'saved' | 'unavailable'; capturedAt: number
}
export interface RetentionListOptions { query?: string; onlyRevoked?: boolean; limit?: number; offset?: number }
export const retentionAccountHash = (identity: string): string => createHash('sha256').update(identity).digest('hex')
const digest = retentionAccountHash
const MAX_MEDIA_BYTES = 64 * 1024 * 1024
export function retentionLocalMediaPath(source: string): string {
  const path = source.startsWith('file:') ? fileURLToPath(source) : source
  // Use native path semantics: Windows drive paths do not start with a slash.
  if (!isAbsolute(path)) throw new Error('仅允许复制本地媒体文件')
  return path
}
const finite = (n: unknown): number => Number.isFinite(Number(n)) ? Number(n) : 0
const decimalId = (v: unknown): string => {
  const s = typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v.trim()
    : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : ''
  return /^\d+$/.test(s) && !/^0+$/.test(s) ? s.replace(/^0+/, '') : ''
}
export function retentionServerId(message: RetentionInput): string {
  // A rounded JS number cannot be repaired. Keep it empty rather than storing a false ID.
  return decimalId(message.serverIdRaw) || decimalId(message.serverId)
}
function xmlId(xml: string, tag: string): string {
  const value = xml.match(new RegExp(`<${tag}\\b[^>]*>\\s*(?:<!\\[CDATA\\[)?(\\d+)(?:\\]\\]>)?\\s*</${tag}>`, 'i'))?.[1]
  return decimalId(value)
}
export function revocationInfo(message: RetentionInput): { serverId: string; serverCandidates: string[]; strongServerCandidates: string[]; localId: string } | null {
  // XML pasted or quoted in an ordinary chat is content, not a system event.
  if (![10000, 10002].includes(Number(message.localType))) return null
  const raw = String(message.rawContent || '')
  const xml = /<revokemsg\b|<sysmsg\b[^>]*\btype\s*=\s*["']revokemsg["']/i.test(raw)
  const systemNotice = [10000, 10002].includes(Number(message.localType)) &&
    /撤回了?一条消息|撤回了一条訊息|recalled a message|retracted a message/i.test(message.parsedContent || raw)
  if (!xml && !systemNotice) return null
  const msgId = xmlId(raw, 'msgid')
  // Some versions use msgid for the server ID, others for a small local row ID.
  const localId = msgId && BigInt(msgId) <= 0xffffffffn ? msgId : ''
  const strongServerCandidates = [...new Set([xmlId(raw, 'newmsgid'), xmlId(raw, 'oldmsgid'), !localId ? msgId : ''].filter(Boolean))]
  const serverCandidates = [...new Set([...strongServerCandidates, msgId].filter(Boolean))]
  return { serverId: serverCandidates[0] || '', serverCandidates, strongServerCandidates, localId }
}

/** An independent local archive. It never opens or modifies a WeChat database. */
export class MessageRetentionStore {
  readonly archivePath: string
  readonly directory: string
  private db: DatabaseSync
  private closed = false
  constructor(userDataPath: string, accountIdentity: string) {
    if (!accountIdentity.trim()) throw new Error('未选择留存账号')
    const root = join(userDataPath, 'Retention')
    this.directory = join(root, retentionAccountHash(accountIdentity))
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700)
    this.archivePath = join(this.directory, 'messages.sqlite')
    this.db = new DatabaseSync(this.archivePath)
    chmodSync(this.archivePath, 0o600)
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, sessionName TEXT NOT NULL,
        senderName TEXT NOT NULL, content TEXT NOT NULL, rawContent TEXT NOT NULL,
        createTime INTEGER NOT NULL, localId INTEGER NOT NULL, serverId TEXT NOT NULL,
        source TEXT NOT NULL, localType INTEGER NOT NULL, isSend INTEGER NOT NULL,
        recalledAt INTEGER, originalMissing INTEGER NOT NULL DEFAULT 0,
        revokeContent TEXT NOT NULL DEFAULT '', mediaPath TEXT, mediaState TEXT NOT NULL DEFAULT 'none',
        capturedAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS retention_server ON messages(sessionId,serverId);
      CREATE INDEX IF NOT EXISTS retention_local ON messages(sessionId,localId,source);
      CREATE INDEX IF NOT EXISTS retention_recalled ON messages(recalledAt);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private map(row: Record<string, unknown>): RetainedMessage {
    return { id: String(row.id), sessionId: String(row.sessionId), sessionName: String(row.sessionName),
      senderName: String(row.senderName), content: String(row.content), rawContent: String(row.rawContent),
      createTime: finite(row.createTime), localId: finite(row.localId), serverId: String(row.serverId),
      localType: finite(row.localType), isSend: Boolean(row.isSend), recalledAt: row.recalledAt == null ? null : finite(row.recalledAt),
      originalMissing: Boolean(row.originalMissing), mediaPath: row.mediaPath ? String(row.mediaPath) : undefined,
      mediaState: String(row.mediaState) as RetainedMessage['mediaState'], capturedAt: finite(row.capturedAt) }
  }
  captureMany(sessionId: string, sessionName: string, messages: RetentionInput[], now = Date.now()): Array<RetainedMessage | null> {
    if (this.closed) return []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = messages.map(message => this.capture(sessionId, sessionName, message, now))
      this.db.exec('COMMIT')
      return rows
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private findUniqueLocal(sessionId: string, localId: number, source: string): Record<string, unknown> | undefined {
    // A row number alone is not an identity across shards. Missing shard metadata
    // or several retained rows at that position make a local-only match ambiguous.
    if (!localId || source.startsWith('|')) return undefined
    const rows = this.db.prepare('SELECT * FROM messages WHERE sessionId=? AND localId=? AND source=? LIMIT 2').all(sessionId, localId, source)
    return rows.length === 1 ? rows[0] : undefined
  }
  capture(sessionId: string, sessionName: string, message: RetentionInput, now = Date.now()): RetainedMessage | null {
    if (this.closed || !sessionId) return null
    const serverId = retentionServerId(message)
    const localId = finite(message.localId)
    const source = [message._db_name || message._db_path || '', message._table_name || ''].join('|')
    const revoke = revocationInfo(message)
    let existing: Record<string, unknown> | undefined
    if (revoke) {
      // newmsgid is a 64-bit decimal string. Never pass it through Number.
      // If explicit target server IDs exist, a short msgid is not an alternative
      // server identity: it can refer to an unrelated local row.
      const candidates = revoke.strongServerCandidates.length ? revoke.strongServerCandidates : revoke.serverCandidates
      for (const candidate of candidates) {
        existing = revoke.strongServerCandidates.length
          ? this.db.prepare('SELECT * FROM messages WHERE sessionId=? AND serverId=? LIMIT 1').get(sessionId, candidate)
          : !source.startsWith('|') ? this.db.prepare('SELECT * FROM messages WHERE sessionId=? AND serverId=? AND source=? LIMIT 1').get(sessionId, candidate, source) : undefined
        if (existing) break
      }
      if (!existing && !revoke.strongServerCandidates.length && revoke.localId) {
        existing = this.findUniqueLocal(sessionId, Number(revoke.localId), source)
      }
      // Only a target-less notice can be inferred to replace its own row. Require
      // the same shard, row, timestamp and non-conflicting server identity.
      if (!existing && !revoke.serverCandidates.length) {
        const replacement = this.findUniqueLocal(sessionId, localId, source)
        if (replacement && finite(replacement.createTime) === finite(message.createTime) &&
          (!serverId || !replacement.serverId || replacement.serverId === serverId)) existing = replacement
      }
      if (existing) {
        if (existing.recalledAt == null) this.db.prepare('UPDATE messages SET recalledAt=?,revokeContent=?,lastSeenAt=? WHERE id=?').run(now, String(message.rawContent || message.parsedContent || ''), now, String(existing.id))
        return this.get(String(existing.id))
      }
      const target = revoke.strongServerCandidates[0] || ''
      const id = digest(`${sessionId}\0${target ? 'server:' + target : 'revoke-local:' + source + ':' + (revoke.localId || localId) + ':' + finite(message.createTime)}`)
      this.db.prepare(`INSERT OR IGNORE INTO messages
        (id,sessionId,sessionName,senderName,content,rawContent,createTime,localId,serverId,source,localType,isSend,recalledAt,originalMissing,revokeContent,capturedAt,lastSeenAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(id, sessionId, sessionName, message.senderDisplayName || message.senderUsername || '',
          '原文未捕获，无法恢复', '', finite(message.createTime), revoke.localId ? Number(revoke.localId) : localId, target, source, finite(message.localType), message.isSend ? 1 : 0, now,
          String(message.rawContent || message.parsedContent || ''), now, now)
      return this.get(id)
    }
    if (serverId) existing = this.db.prepare('SELECT * FROM messages WHERE sessionId=? AND serverId=? LIMIT 1').get(sessionId, serverId)
    if (!existing) {
      const local = this.findUniqueLocal(sessionId, localId, source)
      if (local && (!serverId || !local.serverId || local.serverId === serverId) &&
        (local.originalMissing || finite(local.createTime) === finite(message.createTime))) existing = local
    }
    const id = existing ? String(existing.id) : digest(`${sessionId}\0${serverId ? 'server:' + serverId : 'local:' + source + ':' + localId + ':' + finite(message.createTime)}`)
    if (!existing) existing = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)
    if (existing && !existing.originalMissing) {
      // Outgoing rows may be captured before WeChat assigns a server ID. Enrich
      // the identifier later without replacing the retained original content.
      if (serverId && !existing.serverId) this.db.prepare("UPDATE messages SET serverId=? WHERE id=? AND serverId=''").run(serverId, id)
      return this.get(id)
    }
    const mediaState = [3, 47].includes(Number(message.localType)) ? 'pending' : 'none'
    if (existing) {
      this.db.prepare(`UPDATE messages SET senderName=?,content=?,rawContent=?,createTime=?,localId=?,serverId=?,source=?,localType=?,isSend=?,originalMissing=0,mediaState=?,lastSeenAt=? WHERE id=?`).run(
        message.senderDisplayName || message.senderUsername || '', message.parsedContent || '', message.rawContent || '', finite(message.createTime), localId,
        serverId, source, finite(message.localType), message.isSend ? 1 : 0, mediaState, now, id)
    } else {
      this.db.prepare(`INSERT INTO messages
        (id,sessionId,sessionName,senderName,content,rawContent,createTime,localId,serverId,source,localType,isSend,mediaState,capturedAt,lastSeenAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, sessionId, sessionName, message.senderDisplayName || message.senderUsername || '',
          message.parsedContent || '', message.rawContent || '', finite(message.createTime), localId, serverId, source, finite(message.localType), message.isSend ? 1 : 0, mediaState, now, now)
    }
    return this.get(id)
  }
  get(id: string): RetainedMessage | null { const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id); return row ? this.map(row) : null }
  list(options: RetentionListOptions = {}): { items: RetainedMessage[]; total: number } {
    const conditions: string[] = []; const args: string[] = []
    if (options.onlyRevoked) conditions.push('recalledAt IS NOT NULL')
    const query = String(options.query || '').trim().slice(0, 300)
    if (query) { conditions.push('(instr(content,?)>0 OR instr(sessionName,?)>0 OR instr(senderName,?)>0)'); args.push(query, query, query) }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages' + where).get(...args)?.n || 0)
    const limit = Math.min(200, Math.max(1, Math.floor(finite(options.limit) || 50)))
    const offset = Math.max(0, Math.floor(finite(options.offset)))
    const rows = this.db.prepare('SELECT * FROM messages' + where + ' ORDER BY COALESCE(recalledAt,createTime*1000) DESC,id LIMIT ? OFFSET ?').all(...args, limit, offset)
    return { items: rows.map(row => this.map(row)), total }
  }
  stats(): { totalMessages: number; revokedMessages: number; lastScanAt: number | null } {
    const row = this.db.prepare('SELECT COUNT(*) AS total,SUM(recalledAt IS NOT NULL) AS revoked FROM messages').get()
    const scan = this.db.prepare("SELECT value FROM metadata WHERE key='lastScanAt'").get()
    return { totalMessages: Number(row?.total || 0), revokedMessages: Number(row?.revoked || 0), lastScanAt: scan ? Number(scan.value) : null }
  }
  markScanned(now = Date.now()): void { this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('lastScanAt',?)").run(String(now)) }
  markMediaUnavailable(id: string): void { if (!this.closed) this.db.prepare("UPDATE messages SET mediaState='unavailable' WHERE id=? AND mediaState!='saved'").run(id) }
  async preserveMedia(id: string, source: string): Promise<string | undefined> {
    if (this.closed) return undefined
    const message = this.get(id)
    if (!message || message.originalMissing) return undefined
    if (message.mediaPath && existsSync(message.mediaPath)) return message.mediaPath
    const dir = join(this.directory, 'media'); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700)
    let suffix = '.bin'; let data: Buffer | undefined; let sourcePath: string | undefined
    if (source.startsWith('data:')) {
      const match = source.match(/^data:image\/(png|jpeg|gif|webp);base64,([\s\S]+)$/)
      if (!match || match[2].length > 90_000_000) throw new Error('不支持的媒体内容')
      suffix = '.' + (match[1] === 'jpeg' ? 'jpg' : match[1]); data = Buffer.from(match[2], 'base64')
      if (!data.length || data.length > MAX_MEDIA_BYTES) throw new Error('媒体文件不可用或超过64MB')
    } else {
      sourcePath = retentionLocalMediaPath(source)
      const info = await fs.stat(sourcePath)
      if (!info.isFile() || !info.size || info.size > MAX_MEDIA_BYTES) throw new Error('媒体文件不可用或超过64MB')
      const ext = extname(sourcePath).toLowerCase(); if (/^\.[a-z0-9]{1,8}$/.test(ext)) suffix = ext
    }
    const destination = join(dir, digest(id) + suffix)
    const temp = destination + '.' + randomUUID() + '.tmp'
    try {
      if (this.closed) return undefined
      if (data) await fs.writeFile(temp, data, { mode: 0o600 })
      else await fs.copyFile(sourcePath!, temp)
      const copied = await fs.stat(temp)
      if (copied.size > MAX_MEDIA_BYTES) throw new Error('媒体文件不可用或超过64MB')
      await fs.chmod(temp, 0o600)
      if (this.closed) return undefined
      await fs.rename(temp, destination)
      if (this.closed) { await fs.unlink(destination).catch(() => {}); return undefined }
      this.db.prepare("UPDATE messages SET mediaPath=?,mediaState='saved' WHERE id=?").run(destination, id)
      return destination
    } finally { await fs.unlink(temp).catch(() => {}) }
  }
}
