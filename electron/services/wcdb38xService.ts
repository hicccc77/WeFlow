/**
 * WeChat 3.8.x macOS Database Service
 *
 * WeChat 3.8.x (macOS) uses a completely different database schema than 4.0+:
 *   - SQLCipher 3.x (SHA-1 HMAC, 64000 iterations) — incompatible with libwcdb_api.dylib (SQLCipher 4.x)
 *   - Messages split across msg_0.db … msg_9.db, each with Chat_<md5(username)> tables
 *   - Contact info in Contact/wccontact_new2.db (WCContact table)
 *   - Group message sender encoded in msgContent as "wxid_xxx:\ncontent"
 *
 * This service uses libWCDB.dylib directly via koffi with PRAGMA cipher_compatibility=3.
 */

import { join, basename, dirname } from 'path'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { createHash } from 'crypto'

const SQLITE_ROW = 100
const SQLITE_OPEN_READONLY = 1

interface ContactInfo {
  username: string
  nickname: string
  remark: string
  alias: string
  smallHeadUrl: string
  bigHeadUrl: string
  uiType: number
}

interface RawMessage {
  mesLocalID: number
  mesSvrID: number
  msgCreateTime: number
  msgContent: string | null
  messageType: number
  mesDes: number       // 0=sent by me, 1=received
  msgSource: string | null
  IntRes1: number
  IntRes2: number
  StrRes1: string | null
  StrRes2: string | null
  msgVoiceText: string | null
  msgSeq: number
  conBlobHex: string | null
  CompressContent: string | null
}

export class Wcdb38xService {
  private koffi: any = null
  private lib: any = null

  // sqlite3 bindings (loaded from libWCDB.dylib)
  private sq3OpenV2: any = null
  private sq3Exec: any = null
  private sq3PrepareV2: any = null
  private sq3Step: any = null
  private sq3ColumnCount: any = null
  private sq3ColumnName: any = null
  private sq3ColumnText: any = null
  private sq3ColumnBlob: any = null
  private sq3ColumnBytes: any = null
  private sq3ColumnInt64: any = null
  private sq3ColumnType: any = null
  private sq3Finalize: any = null
  private sq3CloseV2: any = null

  // Database handles — null means not opened
  private msgDbs: (any | null)[] = new Array(10).fill(null)
  private contactDb: any = null
  private groupDb: any = null
  private sessionDb: any = null

  private hexKey: string = ''
  private accountPath: string = ''
  private initialized = false

  // Hash → username reverse map (built from WCContact)
  private hashToUsername: Map<string, string> = new Map()
  // Username → contact info
  private contactCache: Map<string, ContactInfo> = new Map()
  // Hash → which msgDb index (0-9)
  private hashToDbIndex: Map<string, number> = new Map()
  // All known sessions keyed by username
  private sessionMeta: Map<string, { lastTime: number; lastType: number; lastContent: string; lastMesDes: number }> = new Map()

  // Cursor state for message iteration
  private nextCursorId = 1
  private cursors: Map<number, {
    sessionId: string
    batchSize: number
    ascending: boolean
    beginTimestamp: number
    endTimestamp: number
    offset: number    // current fetch offset into sorted results
    totalCount: number
    done: boolean
  }> = new Map()

  private libPath: string = ''
  // Cache for audio directory listings (path → filenames)
  private audioDirCache: Map<string, string[]> = new Map()

  /** Load libWCDB.dylib and bind sqlite3 functions */
  initialize(libWcdbPath: string): boolean {
    if (this.initialized) return true
    try {
      this.koffi = require('koffi')
      this.lib = this.koffi.load(libWcdbPath)
      this.libPath = libWcdbPath

      this.sq3OpenV2 = this.lib.func('int sqlite3_open_v2(str filename, _Out_ void** ppDb, int flags, void* zVfs)')
      this.sq3Exec = this.lib.func('int sqlite3_exec(void* db, str sql, void* callback, void* pArg, _Out_ void** errmsg)')
      this.sq3PrepareV2 = this.lib.func('int sqlite3_prepare_v2(void* db, str sql, int nByte, _Out_ void** ppStmt, _Out_ void** pzTail)')
      this.sq3Step = this.lib.func('int sqlite3_step(void* pStmt)')
      this.sq3ColumnCount = this.lib.func('int sqlite3_column_count(void* pStmt)')
      this.sq3ColumnName = this.lib.func('str sqlite3_column_name(void* pStmt, int N)')
      this.sq3ColumnText = this.lib.func('str sqlite3_column_text(void* pStmt, int iCol)')
      this.sq3ColumnBlob = this.lib.func('void* sqlite3_column_blob(void* pStmt, int iCol)')
      this.sq3ColumnBytes = this.lib.func('int sqlite3_column_bytes(void* pStmt, int iCol)')
      this.sq3ColumnInt64 = this.lib.func('int64 sqlite3_column_int64(void* pStmt, int iCol)')
      this.sq3ColumnType = this.lib.func('int sqlite3_column_type(void* pStmt, int iCol)')
      this.sq3Finalize = this.lib.func('int sqlite3_finalize(void* pStmt)')
      this.sq3CloseV2 = this.lib.func('int sqlite3_close_v2(void* db)')

      this.initialized = true
      return true
    } catch (e) {
      console.error('[wcdb38x] initialize failed:', e)
      return false
    }
  }

  /** Open all databases for a given 3.8.x account path and hex key */
  open(accountPath: string, hexKey: string): boolean {
    this.close()
    if (!this.initialized) return false

    this.accountPath = accountPath
    this.hexKey = hexKey

    // Open msg_0.db … msg_9.db
    const msgDir = join(accountPath, 'Message')
    for (let i = 0; i < 10; i++) {
      const dbPath = join(msgDir, `msg_${i}.db`)
      if (existsSync(dbPath)) {
        const db = this.openSqlite(dbPath)
        if (db) this.msgDbs[i] = db
      }
    }

    // Open contact DB
    const contactDbPath = join(accountPath, 'Contact', 'wccontact_new2.db')
    if (existsSync(contactDbPath)) {
      this.contactDb = this.openSqlite(contactDbPath)
    }

    // Open group DB
    const groupDbPath = join(accountPath, 'Group', 'group_new.db')
    if (existsSync(groupDbPath)) {
      this.groupDb = this.openSqlite(groupDbPath)
    }

    // Open session DB (WeChat 3.8.x stores session list here)
    const sessionDbPath = join(accountPath, 'Session', 'session_new.db')
    if (existsSync(sessionDbPath)) {
      this.sessionDb = this.openSqlite(sessionDbPath)
    }

    // Build caches
    this.buildContactCache()
    this.buildHashToDbIndex()

    return this.msgDbs.some(db => db !== null)
  }

  /** Close all open databases */
  close(): void {
    for (let i = 0; i < 10; i++) {
      if (this.msgDbs[i] !== null) {
        try { this.sq3CloseV2(this.msgDbs[i]) } catch {}
        this.msgDbs[i] = null
      }
    }
    if (this.contactDb) {
      try { this.sq3CloseV2(this.contactDb) } catch {}
      this.contactDb = null
    }
    if (this.groupDb) {
      try { this.sq3CloseV2(this.groupDb) } catch {}
      this.groupDb = null
    }
    if (this.sessionDb) {
      try { this.sq3CloseV2(this.sessionDb) } catch {}
      this.sessionDb = null
    }
    this.hashToUsername.clear()
    this.contactCache.clear()
    this.hashToDbIndex.clear()
    this.sessionMeta.clear()
    this.cursors.clear()
  }

  isOpen(): boolean {
    return this.msgDbs.some(db => db !== null)
  }

  // ─── Session API ──────────────────────────────────────────────────────────

  getSessions(): { success: boolean; sessions?: any[]; error?: string } {
    try {
      if (!this.isOpen()) return { success: false, error: 'DB not open' }

      // Prefer session_new.db (accurate WeChat session list with real usernames)
      if (this.sessionDb) {
        return this.getSessionsFromSessionDb()
      }

      // Fallback: derive sessions from Chat_* tables in msg_*.db
      return this.getSessionsFromMsgDbs()
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private getSessionsFromSessionDb(): { success: boolean; sessions?: any[]; error?: string } {
    try {
      const rows = this.queryRows(this.sessionDb,
        `SELECT m_nsUserName, m_uUnReadCount, m_uLastTime FROM SessionAbstract ORDER BY m_uLastTime DESC`
      )

      const sessions: any[] = []
      for (const r of rows) {
        const username = String(r['m_nsUserName'] || '')
        if (!username || username.startsWith('@placeholder')) continue

        const contact = this.contactCache.get(username)
        const displayName = contact
          ? (contact.remark || contact.nickname || username)
          : username
        const lastTime = Number(r['m_uLastTime'] || 0)
        const unread = Number(r['m_uUnReadCount'] || 0)

        // Get last message summary from msg_*.db
        let summary = ''
        let lastMsgType = 1
        let mesDes = 0
        try {
          const { db, tableName } = this.findChatTable(username)
          if (db && tableName) {
            const lastRows = this.queryRows(db,
              `SELECT msgContent, messageType, mesDes FROM "${tableName}" ORDER BY msgCreateTime DESC LIMIT 1`
            )
            if (lastRows.length > 0) {
              const last = lastRows[0]
              lastMsgType = Number(last['messageType'] || 1)
              mesDes = Number(last['mesDes'] || 0)
              summary = this.buildSummary(String(last['msgContent'] || ''), lastMsgType, username, mesDes)
            }
          }
        } catch { /* summary stays empty */ }

        sessions.push({
          username,
          type: contact ? contact.uiType : 0,
          unreadCount: unread,
          summary,
          sortTimestamp: lastTime,
          lastTimestamp: lastTime,
          lastMsgType,
          displayName,
          avatarUrl: contact?.smallHeadUrl || '',
          alias: contact?.alias || '',
        })
      }

      return { success: true, sessions }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private getSessionsFromMsgDbs(): { success: boolean; sessions?: any[]; error?: string } {
    try {
      const sessionMap: Map<string, any> = new Map()

      for (let dbIdx = 0; dbIdx < 10; dbIdx++) {
        const db = this.msgDbs[dbIdx]
        if (!db) continue

        const tables = this.queryRows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Chat_%'")
        for (const trow of tables) {
          const tableName = String(trow['name'] || '')
          if (!tableName.startsWith('Chat_')) continue

          const hash = tableName.slice(5)
          const username = this.hashToUsername.get(hash) || hash

          const lastRows = this.queryRows(db,
            `SELECT msgCreateTime, messageType, msgContent, mesDes FROM "${tableName}" ORDER BY msgCreateTime DESC LIMIT 1`
          )
          if (lastRows.length === 0) continue

          const last = lastRows[0]
          const existing = sessionMap.get(username)
          const lastTime = Number(last['msgCreateTime'] || 0)
          if (!existing || lastTime > existing.sortTimestamp) {
            const contact = this.contactCache.get(username)
            const displayName = contact
              ? (contact.remark || contact.nickname || username)
              : username
            const msgType = Number(last['messageType'] || 1)
            const mesDes = Number(last['mesDes'] || 0)
            const summary = this.buildSummary(String(last['msgContent'] || ''), msgType, username, mesDes)

            sessionMap.set(username, {
              username,
              type: contact ? contact.uiType : 0,
              unreadCount: 0,
              summary,
              sortTimestamp: lastTime,
              lastTimestamp: lastTime,
              lastMsgType: msgType,
              displayName,
              avatarUrl: contact?.smallHeadUrl || '',
              alias: contact?.alias || '',
            })
          }
        }
      }

      const sessions = Array.from(sessionMap.values())
        .sort((a, b) => b.sortTimestamp - a.sortTimestamp)

      return { success: true, sessions }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // ─── Message API ─────────────────────────────────────────────────────────

  getMessages(username: string, limit: number, offset: number): { success: boolean; messages?: any[]; error?: string } {
    try {
      const { db, tableName } = this.findChatTable(username)
      if (!db || !tableName) return { success: false, error: `未找到 ${username} 的消息表` }

      const rows = this.queryRows(db,
        `SELECT mesLocalID, mesSvrID, msgCreateTime, msgContent, messageType, mesDes, msgSource, IntRes1, IntRes2, StrRes1, StrRes2, msgVoiceText, msgSeq
         FROM "${tableName}"
         ORDER BY msgCreateTime DESC
         LIMIT ${limit} OFFSET ${offset}`
      )

      const messages = rows.map(r => this.mapMessage(r, username)).reverse()
      return { success: true, messages }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  getMessageCount(username: string): { success: boolean; count?: number; error?: string } {
    try {
      const { db, tableName } = this.findChatTable(username)
      if (!db || !tableName) return { success: false, error: `未找到 ${username} 的消息表` }

      const rows = this.queryRows(db, `SELECT COUNT(1) AS cnt FROM "${tableName}"`)
      return { success: true, count: Number(rows[0]?.['cnt'] || 0) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // ─── Contact API ─────────────────────────────────────────────────────────

  getDisplayNames(usernames: string[]): { success: boolean; names?: Record<string, string>; error?: string } {
    try {
      const names: Record<string, string> = {}
      for (const u of usernames) {
        const effective = this.resolveUsername(u)
        const c = this.contactCache.get(effective)
        names[u] = c ? (c.remark || c.nickname || c.username) : u
      }
      return { success: true, names }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  getContactsCompact(): { success: boolean; contacts?: any[]; error?: string } {
    try {
      const contacts: any[] = []

      // Personal contacts from WCContact
      if (this.contactDb) {
        const rows = this.queryRows(this.contactDb,
          `SELECT m_nsUsrName, nickname, m_nsRemark, m_nsAliasName, m_nsHeadImgUrl, m_nsHeadHDImgUrl, m_uiType
           FROM WCContact`
        )
        for (const r of rows) {
          contacts.push({
            username: String(r['m_nsUsrName'] || ''),
            nickname: String(r['nickname'] || ''),
            remark: String(r['m_nsRemark'] || ''),
            alias: String(r['m_nsAliasName'] || ''),
            smallHeadUrl: String(r['m_nsHeadImgUrl'] || ''),
            bigHeadUrl: String(r['m_nsHeadHDImgUrl'] || ''),
            // In 3.8.x, WCContact IS the friend list. m_uiType uses different semantics
            // than 4.0+ (where 1=friend). Normalize to 1 so chatService classifies correctly.
            localType: 1,
          })
        }
      }

      // Group chats from GroupContact (NOT in WCContact)
      if (this.groupDb) {
        const groupRows = this.queryRows(this.groupDb,
          `SELECT m_nsUsrName, nickname, m_nsRemark, m_nsHeadImgUrl, m_nsHeadHDImgUrl FROM GroupContact`
        )
        for (const r of groupRows) {
          contacts.push({
            username: String(r['m_nsUsrName'] || ''),
            nickname: String(r['nickname'] || ''),
            remark: String(r['m_nsRemark'] || ''),
            alias: '',
            smallHeadUrl: String(r['m_nsHeadImgUrl'] || ''),
            bigHeadUrl: String(r['m_nsHeadHDImgUrl'] || ''),
            localType: 2,  // group
          })
        }
      }

      return { success: true, contacts }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /** Resolve a possible 32-char account-dir hash to the actual wxid */
  private resolveUsername(username: string): string {
    if (/^[0-9a-f]{32}$/i.test(username)) {
      return this.hashToUsername.get(username.toLowerCase()) || username
    }
    return username
  }

  /** Returns the actual WeChat wxid of the current account owner, or null if not resolvable */
  getSelfWxid(): string | null {
    // Primary: parse topinfo.data at the 2.0b4.0.9/ root — it's a protobuf where field 1 is the self wxid
    const topinfoPath = join(dirname(this.accountPath), 'topinfo.data')
    if (existsSync(topinfoPath)) {
      try {
        const data = readFileSync(topinfoPath)
        // Protobuf field 1, type LEN (tag byte 0x0a)
        if (data.length >= 3 && data[0] === 0x0a) {
          const len = data[1]  // varint length (1-byte for wxids ≤ 127 chars)
          if (len > 0 && len + 2 <= data.length) {
            const wxid = data.slice(2, 2 + len).toString('utf8')
            if (wxid && /^[a-zA-Z0-9_\-]{3,32}$/.test(wxid)) {
              return wxid
            }
          }
        }
      } catch {}
    }
    // Fallback 1: scan WCContact for someone whose md5(username) matches the account dir hash
    const hash = basename(this.accountPath).toLowerCase()
    for (const [username] of this.contactCache) {
      if (this.md5(username) === hash) return username
    }
    // Fallback 2: scan GroupMember table (self always appears there as a participant)
    if (this.groupDb) {
      try {
        const rows = this.queryRows(this.groupDb, "SELECT DISTINCT m_nsUsrName FROM GroupMember WHERE m_nsUsrName LIKE 'wxid_%' LIMIT 5000")
        for (const r of rows) {
          const u = String(r['m_nsUsrName'] || '')
          if (u && this.md5(u) === hash) return u
        }
      } catch {}
    }
    return null
  }

  getSelfContact(): { nickname: string; alias: string; smallHeadUrl: string; username: string } | null {
    const selfWxid = this.getSelfWxid()
    if (!selfWxid) return null

    // Try WCContact first (self usually isn't there in 3.8.x, but try anyway)
    const c = this.contactCache.get(selfWxid)
    if (c && c.nickname) return { nickname: c.nickname, alias: c.alias, smallHeadUrl: c.smallHeadUrl, username: c.username }

    // Fallback: look up in GroupMember table — self appears there as a group participant
    if (this.groupDb) {
      try {
        const safe = selfWxid.replace(/'/g, "''")
        const rows = this.queryRows(this.groupDb,
          `SELECT m_nsUsrName, nickname, m_nsHeadImgUrl FROM GroupMember WHERE m_nsUsrName='${safe}' LIMIT 1`
        )
        if (rows.length > 0) {
          const r = rows[0]
          return {
            username: selfWxid,
            nickname: String(r['nickname'] || ''),
            alias: selfWxid,
            smallHeadUrl: String(r['m_nsHeadImgUrl'] || ''),
          }
        }
      } catch {}
    }
    return null
  }

  getContact(username: string): { success: boolean; contact?: any; error?: string } {
    try {
      const effective = this.resolveUsername(username)
      const c = this.contactCache.get(effective)
      if (!c) {
        // Self user isn't in WCContact — check GroupMember as fallback
        const selfContact = this.getSelfContact()
        if (selfContact && (selfContact.username === effective || selfContact.alias === effective)) {
          return {
            success: true,
            contact: {
              username: selfContact.username,
              nickname: selfContact.nickname,
              remark: '',
              alias: selfContact.alias,
              smallHeadUrl: selfContact.smallHeadUrl,
              bigHeadUrl: selfContact.smallHeadUrl,
              localType: 1,
              displayName: selfContact.nickname || selfContact.username,
            }
          }
        }
        return { success: false, error: `未找到联系人 ${username}` }
      }
      return {
        success: true,
        contact: {
          username: c.username,
          nickname: c.nickname,
          remark: c.remark,
          alias: c.alias,
          smallHeadUrl: c.smallHeadUrl,
          bigHeadUrl: c.bigHeadUrl,
          localType: c.uiType,
          displayName: c.remark || c.nickname || c.username,
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  getAvatarUrls(usernames: string[]): { success: boolean; avatars?: Record<string, string>; error?: string } {
    try {
      const avatars: Record<string, string> = {}
      for (const u of usernames) {
        const effective = this.resolveUsername(u)
        const c = this.contactCache.get(effective)
        if (c?.smallHeadUrl) avatars[u] = c.smallHeadUrl
      }
      return { success: true, avatars }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /** Execute arbitrary SQL on specified database type.
   *  dbType: 'contact' | 'msg' | 'group'
   *  sessionId: used to pick msg_N.db for dbType='msg'
   */
  execQuery(dbType: string, sessionId: string | null, sql: string): { success: boolean; rows?: any[]; error?: string } {
    try {
      let db: any = null
      if (dbType === 'contact') {
        db = this.contactDb
      } else if (dbType === 'group') {
        db = this.groupDb
      } else if (dbType === 'msg') {
        if (sessionId) {
          const result = this.findChatTable(sessionId)
          db = result.db
        } else {
          db = this.msgDbs.find(d => d !== null) || null
        }
      } else {
        db = this.msgDbs.find(d => d !== null) || this.contactDb
      }
      if (!db) return { success: false, error: `数据库 ${dbType} 未打开` }
      const rows = this.queryRows(db, sql)
      return { success: true, rows }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // ─── Group Member API ─────────────────────────────────────────────────────

  /** Get members of a chatroom from group_new.db GroupMember + GroupUserRelation */
  getGroupMembers(chatroomId: string): { success: boolean; members?: any[]; error?: string } {
    try {
      if (!this.groupDb) return { success: false, error: 'group DB not open' }
      const safe = chatroomId.replace(/'/g, "''")
      const rows = this.queryRows(this.groupDb,
        `SELECT gm.m_nsUsrName, gm.nickname, gm.m_nsRemark, gm.m_nsAliasName, gm.m_nsHeadImgUrl, gm.m_nsHeadHDImgUrl
         FROM GroupMember gm
         INNER JOIN GroupUserRelation gur ON gm.m_nsUsrName = gur.userName
         WHERE gur.groupNameList LIKE '%${safe}%'
         LIMIT 500`
      )
      const members = rows.map(r => ({
        username: String(r['m_nsUsrName'] || ''),
        nickname: String(r['nickname'] || r['m_nsRemark'] || r['m_nsUsrName'] || ''),
        smallHeadUrl: String(r['m_nsHeadImgUrl'] || ''),
        bigHeadUrl: String(r['m_nsHeadHDImgUrl'] || ''),
      }))
      return { success: true, members }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  getGroupNicknames(chatroomId: string, usernames: string[]): { success: boolean; map?: Record<string, string>; error?: string } {
    try {
      const map: Record<string, string> = {}
      // First try group members
      if (this.groupDb) {
        const safe = chatroomId.replace(/'/g, "''")
        const inList = usernames.map(u => `'${u.replace(/'/g, "''")}'`).join(',')
        const rows = this.queryRows(this.groupDb,
          `SELECT gm.m_nsUsrName, gm.nickname, gm.m_nsRemark
           FROM GroupMember gm
           INNER JOIN GroupUserRelation gur ON gm.m_nsUsrName = gur.userName
           WHERE gur.groupNameList LIKE '%${safe}%' AND gm.m_nsUsrName IN (${inList})
           LIMIT 500`
        )
        for (const r of rows) {
          const u = String(r['m_nsUsrName'] || '')
          if (u) map[u] = String(r['m_nsRemark'] || r['nickname'] || u)
        }
      }
      // Fallback to contact cache
      for (const u of usernames) {
        if (!map[u]) {
          const c = this.contactCache.get(u)
          if (c) map[u] = c.remark || c.nickname || u
        }
      }
      return { success: true, map }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /** Count distinct groups in GroupContact table */
  countGroups(): number {
    try {
      if (!this.groupDb) return 0
      const rows = this.queryRows(this.groupDb, 'SELECT COUNT(1) AS cnt FROM GroupContact')
      return Number(rows[0]?.['cnt'] || 0)
    } catch {
      return 0
    }
  }

  getGroupMemberCount(chatroomId: string): { success: boolean; count?: number; error?: string } {
    try {
      if (!this.groupDb) return { success: true, count: 0 }
      const safe = chatroomId.replace(/'/g, "''")
      const rows = this.queryRows(this.groupDb,
        `SELECT COUNT(1) AS cnt FROM GroupMember gm
         INNER JOIN GroupUserRelation gur ON gm.m_nsUsrName = gur.userName
         WHERE gur.groupNameList LIKE '%${safe}%'`
      )
      return { success: true, count: Number(rows[0]?.['cnt'] || 0) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  getGroupMemberCounts(chatroomIds: string[]): { success: boolean; map?: Record<string, number>; error?: string } {
    try {
      const map: Record<string, number> = {}
      for (const id of chatroomIds) {
        const r = this.getGroupMemberCount(id)
        map[id] = r.success ? (r.count ?? 0) : 0
      }
      return { success: true, map }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取单个会话的消息在各 msg_N.db 中的分布（数据库分布 + 年度报告用）
   */
  getMessageTableStats(sessionId: string): { success: boolean; tables?: any[]; error?: string } {
    try {
      const tables: any[] = []
      for (let i = 0; i < 10; i++) {
        const db = this.msgDbs[i]
        if (!db) continue
        const dbPath = join(this.accountPath, 'Message', `msg_${i}.db`)
        const tableName = `Chat_${this.md5(sessionId)}`
        try {
          const rows = this.queryRows(db,
            `SELECT COUNT(*) AS cnt, MIN(msgCreateTime) AS first_ts, MAX(msgCreateTime) AS last_ts FROM "${tableName}"`
          )
          if (rows.length > 0 && Number(rows[0]['cnt']) > 0) {
            tables.push({
              db_path: dbPath,
              table_name: tableName,
              count: Number(rows[0]['cnt']),
              first_timestamp: Number(rows[0]['first_ts'] || 0),
              last_timestamp: Number(rows[0]['last_ts'] || 0)
            })
          }
        } catch { /* table not in this db */ }
      }
      return { success: true, tables }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取多个会话涵盖的年份（年度报告用）
   */
  getAvailableYears(sessionIds: string[]): { success: boolean; data?: number[]; error?: string } {
    try {
      const years = new Set<number>()
      for (let i = 0; i < 10; i++) {
        const db = this.msgDbs[i]
        if (!db) continue
        for (const sessionId of sessionIds) {
          const tableName = `Chat_${this.md5(sessionId)}`
          try {
            const rows = this.queryRows(db,
              `SELECT MIN(msgCreateTime) AS first_ts, MAX(msgCreateTime) AS last_ts FROM "${tableName}"`
            )
            if (rows.length > 0) {
              const first = Number(rows[0]['first_ts'] || 0)
              const last = Number(rows[0]['last_ts'] || 0)
              if (first > 0) years.add(new Date(first * 1000).getFullYear())
              if (last > 0) years.add(new Date(last * 1000).getFullYear())
            }
          } catch { /* table not in this db */ }
        }
      }
      const data = Array.from(years).sort((a, b) => b - a)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 聚合统计多个会话的消息（年度报告 / 聊天分析用）
   */
  computeAggregateStats(
    sessionIds: string[],
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): { success: boolean; data?: any; error?: string } {
    try {
      const selfWxid = this.getSelfWxid() || ''
      const total_sessions: Record<string, { total: number; sent: number; received: number; monthly: Record<number, number>; senders: Record<string, number> }> = {}
      const hourly: Record<number, number> = {}
      const weekday: Record<number, number> = {}
      const daily: Record<string, number> = {}
      const monthly: Record<string, number> = {}
      const typeCounts: Record<number, number> = {}
      let total = 0, sent = 0, received = 0
      let firstTime = 0, lastTime = 0

      for (const sessionId of sessionIds) {
        const cursorResult = this.openMessageCursor(sessionId, 500, true, beginTimestamp, endTimestamp)
        if (!cursorResult.success || cursorResult.cursor === undefined) continue
        const cursorId = cursorResult.cursor

        const sessionStat = { total: 0, sent: 0, received: 0, monthly: {} as Record<number, number>, senders: {} as Record<string, number> }

        while (true) {
          const batch = this.fetchMessageBatch(cursorId)
          if (!batch.success || !batch.rows || batch.rows.length === 0) break

          for (const row of batch.rows) {
            const ts = Number(row.createTime || row.msgCreateTime || 0)
            if (!ts) continue
            if (beginTimestamp > 0 && ts < beginTimestamp) continue
            if (endTimestamp > 0 && ts > endTimestamp) continue

            total++
            sessionStat.total++

            const d = new Date(ts * 1000)
            const hour = d.getHours()
            const wd = d.getDay()
            const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
            const dayKey = `${monthKey}-${String(d.getDate()).padStart(2, '0')}`
            const monthNum = d.getMonth() + 1

            hourly[hour] = (hourly[hour] || 0) + 1
            weekday[wd] = (weekday[wd] || 0) + 1
            daily[dayKey] = (daily[dayKey] || 0) + 1
            monthly[monthKey] = (monthly[monthKey] || 0) + 1
            sessionStat.monthly[monthNum] = (sessionStat.monthly[monthNum] || 0) + 1

            const msgType = Number(row.localType ?? row.messageType ?? 1)
            typeCounts[msgType] = (typeCounts[msgType] || 0) + 1

            const isSend = row.isSend === 1 || row.isSend === true || String(row.computed_is_send) === '1'
            if (isSend) {
              sent++
              sessionStat.sent++
              if (selfWxid) sessionStat.senders[selfWxid] = (sessionStat.senders[selfWxid] || 0) + 1
            } else {
              received++
              sessionStat.received++
              const sender = String(row.senderUsername || row.sender_username || '')
              if (sender) sessionStat.senders[sender] = (sessionStat.senders[sender] || 0) + 1
            }

            if (firstTime === 0 || ts < firstTime) firstTime = ts
            if (ts > lastTime) lastTime = ts
          }
          if (!batch.hasMore) break
        }
        this.closeMessageCursor(cursorId)
        if (sessionStat.total > 0) total_sessions[sessionId] = sessionStat
      }

      return {
        success: true,
        data: { total, sent, received, firstTime, lastTime, hourly, weekday, daily, monthly, typeCounts, sessions: total_sessions, idMap: {} }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 按 localId 查找消息（合并转发消息的引用跳转用）
   */
  getMessageById(sessionId: string, localId: number): { success: boolean; message?: any; error?: string } {
    try {
      const { db, tableName } = this.findChatTable(sessionId)
      if (!db || !tableName) return { success: false, error: `未找到 ${sessionId} 的消息表` }
      const rows = this.queryRows(db,
        `SELECT mesLocalID, mesSvrID, msgCreateTime, msgContent, messageType, mesDes, msgSource, IntRes1, IntRes2, StrRes1, StrRes2, msgVoiceText, msgSeq
         FROM "${tableName}" WHERE mesLocalID = ${Number(localId)} LIMIT 1`
      )
      if (rows.length === 0) return { success: false, error: '未找到消息' }
      return { success: true, message: this.mapMessage(rows[0], sessionId) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  getGroupStats(
    chatroomId: string,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): { success: boolean; data?: any; error?: string } {
    try {
      const selfWxid = this.getSelfWxid() || ''
      const hourly: Record<number, number> = {}
      const typeCounts: Record<string, number> = {}
      const senders: Record<string, number> = {}
      let total = 0, sent = 0, received = 0

      const cursorResult = this.openMessageCursor(chatroomId, 500, true, beginTimestamp, endTimestamp)
      if (!cursorResult.success || cursorResult.cursor === undefined) {
        return { success: false, error: cursorResult.error || '无法打开游标' }
      }
      const cursorId = cursorResult.cursor

      while (true) {
        const batch = this.fetchMessageBatch(cursorId)
        if (!batch.success || !batch.rows || batch.rows.length === 0) break

        for (const row of batch.rows) {
          total++
          // fetchMessageBatch returns mapMessage() output (camelCase fields)
          const ts: number = Number(row.createTime || row.msgCreateTime || 0)
          const hour = new Date(ts * 1000).getHours()
          hourly[hour] = (hourly[hour] || 0) + 1

          const typeStr = String(row.localType ?? row.messageType ?? 1)
          typeCounts[typeStr] = (typeCounts[typeStr] || 0) + 1

          // isSend: mapMessage sets isSend=1 for sent, 0 for received
          const isSend = row.isSend === 1 || row.isSend === true || String(row.computed_is_send) === '1'
          let sender: string
          if (isSend) {
            sender = selfWxid
            sent++
          } else {
            received++
            // mapMessage already extracts senderUsername for group messages
            sender = String(row.senderUsername || row.sender_username || '')
          }
          if (sender) {
            senders[sender] = (senders[sender] || 0) + 1
          }
        }

        if (!batch.hasMore) break
      }

      this.closeMessageCursor(cursorId)

      return {
        success: true,
        data: {
          total, sent, received,
          hourly,
          typeCounts,
          sessions: { [chatroomId]: { total, sent, received, senders } },
          idMap: {}
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // ─── Cursor API (mirrors wcdbCore cursor interface) ───────────────────────

  openMessageCursor(
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number
  ): { success: boolean; cursor?: number; error?: string } {
    try {
      const { db, tableName } = this.findChatTable(sessionId)
      if (!db || !tableName) return { success: false, error: `未找到 ${sessionId} 的消息表` }

      // Count total for done detection
      let countSql = `SELECT COUNT(1) AS cnt FROM "${tableName}"`
      if (beginTimestamp > 0 || endTimestamp > 0) {
        const clauses: string[] = []
        if (beginTimestamp > 0) clauses.push(`msgCreateTime >= ${beginTimestamp}`)
        if (endTimestamp > 0) clauses.push(`msgCreateTime <= ${endTimestamp}`)
        countSql += ` WHERE ${clauses.join(' AND ')}`
      }
      const countRows = this.queryRows(db, countSql)
      const totalCount = Number(countRows[0]?.['cnt'] || 0)

      const cursorId = this.nextCursorId++
      this.cursors.set(cursorId, {
        sessionId,
        batchSize: Math.max(1, batchSize),
        ascending,
        beginTimestamp,
        endTimestamp,
        offset: 0,
        totalCount,
        done: totalCount === 0,
      })
      return { success: true, cursor: cursorId }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  fetchMessageBatch(cursorId: number): { success: boolean; rows?: any[]; hasMore?: boolean; error?: string } {
    try {
      const state = this.cursors.get(cursorId)
      if (!state) return { success: false, error: `游标 ${cursorId} 不存在` }
      if (state.done) return { success: true, rows: [], hasMore: false }

      const { db, tableName } = this.findChatTable(state.sessionId)
      if (!db || !tableName) return { success: false, error: `未找到 ${state.sessionId} 的消息表` }

      const order = state.ascending ? 'ASC' : 'DESC'
      const clauses: string[] = []
      if (state.beginTimestamp > 0) clauses.push(`msgCreateTime >= ${state.beginTimestamp}`)
      if (state.endTimestamp > 0) clauses.push(`msgCreateTime <= ${state.endTimestamp}`)
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

      const sql = `SELECT mesLocalID, mesSvrID, msgCreateTime, msgContent, messageType, mesDes, msgSource, IntRes1, IntRes2, StrRes1, StrRes2, msgVoiceText, msgSeq
                   FROM "${tableName}"
                   ${where}
                   ORDER BY msgCreateTime ${order}
                   LIMIT ${state.batchSize} OFFSET ${state.offset}`

      const rawRows = this.queryRows(db, sql)
      const rows = rawRows.map(r => this.mapMessage(r, state.sessionId))

      state.offset += rawRows.length
      const hasMore = state.offset < state.totalCount
      if (!hasMore) state.done = true

      return { success: true, rows, hasMore }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  closeMessageCursor(cursorId: number): { success: boolean; error?: string } {
    this.cursors.delete(cursorId)
    return { success: true }
  }

  /** Get distinct message dates (YYYY-MM-DD) for a session */
  getMessageDates(username: string): { success: boolean; dates?: string[]; error?: string } {
    try {
      const { db, tableName } = this.findChatTable(username)
      if (!db || !tableName) return { success: true, dates: [] }
      const rows = this.queryRows(db,
        `SELECT DISTINCT strftime('%Y-%m-%d', msgCreateTime, 'unixepoch', 'localtime') AS d
         FROM "${tableName}" WHERE msgCreateTime > 0 ORDER BY d`
      )
      const dates = rows.map(r => String(r['d'] || '')).filter(Boolean)
      return { success: true, dates }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /** Get messages by type (for image/voice export) */
  getMessagesByType(username: string, msgType: number, ascending: boolean, limit: number, offset: number): { success: boolean; messages?: any[]; error?: string } {
    try {
      const { db, tableName } = this.findChatTable(username)
      if (!db || !tableName) return { success: true, messages: [] }
      const order = ascending ? 'ASC' : 'DESC'
      const limitClause = limit > 0 ? `LIMIT ${limit} OFFSET ${offset}` : ''
      const rows = this.queryRows(db,
        `SELECT mesLocalID, mesSvrID, msgCreateTime, msgContent, messageType, mesDes, msgSource, IntRes1, IntRes2, StrRes1, StrRes2, msgVoiceText, msgSeq
         FROM "${tableName}"
         WHERE messageType = ${msgType}
         ORDER BY msgCreateTime ${order} ${limitClause}`
      )
      const messages = rows.map(r => this.mapMessage(r, username))
      return { success: true, messages }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /** Simple keyword search across all Chat tables */
  searchMessages(keyword: string, sessionId?: string, limit = 50, offset = 0): { success: boolean; messages?: any[]; error?: string } {
    try {
      if (!keyword) return { success: true, messages: [] }
      const safeKeyword = keyword.replace(/'/g, "''")
      const results: any[] = []

      const searchInDb = (db: any, tableName: string, username: string) => {
        const rows = this.queryRows(db,
          `SELECT mesLocalID, mesSvrID, msgCreateTime, msgContent, messageType, mesDes, msgSource, IntRes1, IntRes2, StrRes1, StrRes2, msgVoiceText, msgSeq
           FROM "${tableName}"
           WHERE messageType = 1 AND msgContent LIKE '%${safeKeyword}%'
           ORDER BY msgCreateTime DESC LIMIT ${limit + offset}`
        )
        for (const r of rows) {
          results.push({ ...this.mapMessage(r, username), sessionId: username })
        }
      }

      if (sessionId) {
        const { db, tableName } = this.findChatTable(sessionId)
        if (db && tableName) searchInDb(db, tableName, sessionId)
      } else {
        for (let i = 0; i < 10; i++) {
          const db = this.msgDbs[i]
          if (!db) continue
          const tables = this.queryRows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Chat_%'")
          for (const t of tables) {
            const tableName = String(t['name'] || '')
            const hash = tableName.slice(5)
            const username = this.hashToUsername.get(hash) || hash
            searchInDb(db, tableName, username)
            if (results.length >= limit + offset + 100) break
          }
        }
      }

      results.sort((a, b) => b.createTime - a.createTime)
      const sliced = results.slice(offset, offset + limit)
      return { success: true, messages: sliced }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private md5(s: string): string {
    return createHash('md5').update(s).digest('hex')
  }

  private openSqlite(dbPath: string): any | null {
    try {
      const ppDb: any[] = [null]
      const rc = this.sq3OpenV2(dbPath, ppDb, SQLITE_OPEN_READONLY, null)
      if (rc !== 0) return null
      const db = ppDb[0]
      if (!db) return null
      const pErrmsg: any[] = [null]
      this.sq3Exec(db, `PRAGMA key="x'${this.hexKey}'"`, null, null, pErrmsg)
      this.sq3Exec(db, `PRAGMA cipher_compatibility=3`, null, null, pErrmsg)
      return db
    } catch {
      return null
    }
  }

  private queryRows(db: any, sql: string, maxRows = 100000): Array<Record<string, any>> {
    const ppStmt: any[] = [null]
    const pzTail: any[] = [null]
    const rc = this.sq3PrepareV2(db, sql, -1, ppStmt, pzTail)
    if (rc !== 0) return []
    const stmt = ppStmt[0]
    const rows: Array<Record<string, any>> = []
    let count = 0
    while (this.sq3Step(stmt) === SQLITE_ROW && count < maxRows) {
      const ncols = this.sq3ColumnCount(stmt)
      const row: Record<string, any> = {}
      for (let i = 0; i < ncols; i++) {
        const name = this.sq3ColumnName(stmt, i)
        const type = this.sq3ColumnType(stmt, i) // 1=INT,2=FLOAT,3=TEXT,4=BLOB,5=NULL
        if (type === 1 || type === 2) {
          // Use text representation to avoid precision loss for large int64 values (e.g., mesSvrID)
          const textVal = this.sq3ColumnText(stmt, i)
          const numVal = Number(textVal)
          row[name] = Number.isSafeInteger(numVal) ? numVal : (textVal ?? 0)
        } else if (type === 4) {
          // BLOB: read as hex string for CompressContent, ConBlob
          const ptr = this.sq3ColumnBlob(stmt, i)
          const len = this.sq3ColumnBytes(stmt, i)
          if (ptr && len > 0) {
            try {
              const arr = this.koffi.decode(ptr, 'uint8', len)
              row[name] = Buffer.from(arr).toString('hex')
            } catch {
              row[name] = null
            }
          } else {
            row[name] = null
          }
        } else if (type === 5) {
          row[name] = null
        } else {
          row[name] = this.sq3ColumnText(stmt, i)
        }
      }
      rows.push(row)
      count++
    }
    this.sq3Finalize(stmt)
    return rows
  }

  private buildContactCache(): void {
    // Load personal contacts from WCContact
    if (this.contactDb) {
      const rows = this.queryRows(this.contactDb,
        `SELECT m_nsUsrName, nickname, m_nsRemark, m_nsAliasName, m_nsHeadImgUrl, m_nsHeadHDImgUrl, m_uiType
         FROM WCContact`
      )
      for (const r of rows) {
        const username = String(r['m_nsUsrName'] || '')
        if (!username) continue
        const contact: ContactInfo = {
          username,
          nickname: String(r['nickname'] || ''),
          remark: String(r['m_nsRemark'] || ''),
          alias: String(r['m_nsAliasName'] || ''),
          smallHeadUrl: String(r['m_nsHeadImgUrl'] || ''),
          bigHeadUrl: String(r['m_nsHeadHDImgUrl'] || ''),
          uiType: Number(r['m_uiType'] || 0),
        }
        this.contactCache.set(username, contact)
        this.hashToUsername.set(this.md5(username), username)
      }
    }

    // Also load group chats from GroupContact (groups are NOT in WCContact)
    if (this.groupDb) {
      const groupRows = this.queryRows(this.groupDb,
        `SELECT m_nsUsrName, nickname, m_nsRemark, m_nsHeadImgUrl, m_nsHeadHDImgUrl
         FROM GroupContact`
      )
      for (const r of groupRows) {
        const username = String(r['m_nsUsrName'] || '')
        if (!username || this.contactCache.has(username)) continue
        const contact: ContactInfo = {
          username,
          nickname: String(r['nickname'] || ''),
          remark: String(r['m_nsRemark'] || ''),
          alias: '',
          smallHeadUrl: String(r['m_nsHeadImgUrl'] || ''),
          bigHeadUrl: String(r['m_nsHeadHDImgUrl'] || ''),
          uiType: 2,  // group type
        }
        this.contactCache.set(username, contact)
        this.hashToUsername.set(this.md5(username), username)
      }
    }
  }

  private buildHashToDbIndex(): void {
    for (let i = 0; i < 10; i++) {
      const db = this.msgDbs[i]
      if (!db) continue
      const tables = this.queryRows(db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Chat_%'"
      )
      for (const t of tables) {
        const tableName = String(t['name'] || '')
        if (!tableName.startsWith('Chat_')) continue
        const hash = tableName.slice(5)
        if (!this.hashToDbIndex.has(hash)) {
          this.hashToDbIndex.set(hash, i)
        }
      }
    }
  }

  private findChatTable(username: string): { db: any; tableName: string | null } {
    const hash = this.md5(username)
    const dbIdx = this.hashToDbIndex.get(hash)
    if (dbIdx !== undefined) {
      const db = this.msgDbs[dbIdx]
      return { db, tableName: `Chat_${hash}` }
    }
    // Try direct username (old-style WeChat IDs: table is Chat_{username})
    const directIdx = this.hashToDbIndex.get(username)
    if (directIdx !== undefined) {
      return { db: this.msgDbs[directIdx], tableName: `Chat_${username}` }
    }
    // If username is already a 32-char hex hash (non-contact fallback), try it directly first
    const isAlreadyHash = /^[0-9a-f]{32}$/i.test(username)
    if (isAlreadyHash) {
      const directTable = `Chat_${username.toLowerCase()}`
      const cachedIdx = this.hashToDbIndex.get(username.toLowerCase())
      if (cachedIdx !== undefined) {
        return { db: this.msgDbs[cachedIdx], tableName: directTable }
      }
      for (let i = 0; i < 10; i++) {
        const db = this.msgDbs[i]
        if (!db) continue
        const exists = this.queryRows(db,
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${directTable}'`
        )
        if (exists.length > 0) {
          this.hashToDbIndex.set(username.toLowerCase(), i)
          return { db, tableName: directTable }
        }
      }
    }
    // Fallback: scan all dbs
    const tableName = `Chat_${hash}`
    for (let i = 0; i < 10; i++) {
      const db = this.msgDbs[i]
      if (!db) continue
      const exists = this.queryRows(db,
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`
      )
      if (exists.length > 0) {
        this.hashToDbIndex.set(hash, i)
        return { db, tableName }
      }
    }
    return { db: null, tableName: null }
  }

  /** Extract sender from group message content ("wxid_xxx:\ncontent") */
  private extractGroupSender(content: string): { sender: string | null; text: string } {
    if (!content) return { sender: null, text: content }
    const idx = content.indexOf(':\n')
    if (idx > 0) {
      const candidate = content.slice(0, idx)
      // wxid_ prefix or phone-like number or chatroom member
      if (/^(wxid_|gh_|\+?[\d]{6,}|[0-9a-f]{32}@chatroom|[a-zA-Z0-9_\-]{4,30})/.test(candidate)) {
        return { sender: candidate, text: content.slice(idx + 2) }
      }
    }
    return { sender: null, text: content }
  }

  private buildSummary(content: string, msgType: number, username: string, mesDes: number): string {
    const isGroup = username.endsWith('@chatroom')
    switch (msgType) {
      case 1: {
        let text = content
        if (isGroup && mesDes === 1) {
          text = this.extractGroupSender(content).text
        }
        return text.slice(0, 100).replace(/\n/g, ' ')
      }
      case 3: return '[图片]'
      case 34: return '[语音]'
      case 43: return '[视频]'
      case 47: return '[表情]'
      case 48: return '[位置]'
      case 49: return '[分享]'
      case 10000: return content ? content.slice(0, 80) : '[系统消息]'
      default: return '[消息]'
    }
  }

  private mapMessage(r: Record<string, any>, sessionUsername: string): any {
    const isGroup = sessionUsername.endsWith('@chatroom')
    const mesDes = Number(r['mesDes'] || 0)
    const isSend = mesDes === 0 ? 1 : 0
    const msgType = Number(r['messageType'] || 1)
    const rawContent = String(r['msgContent'] || '')

    let parsedContent = rawContent
    let senderUsername: string | null = null

    if (isGroup && mesDes === 1) {
      const extracted = this.extractGroupSender(rawContent)
      senderUsername = extracted.sender
      parsedContent = extracted.text
    }

    const localId = Number(r['mesLocalID'] || 0)
    // mesSvrID can exceed JS Number precision; keep as string to preserve exact file name prefix
    const serverIdStr = String(r['mesSvrID'] || '0')
    const serverId = Number(serverIdStr)  // numeric version (may lose precision for large values)
    const createTime = Number(r['msgCreateTime'] || 0)

    // ── Media path resolution for 3.8.x ─────────────────────────────────────
    let imageMd5: string | undefined
    let imageDatName: string | undefined
    let voiceDurationSeconds: number | undefined
    let localAudioPath: string | undefined
    let videoLocalPath: string | undefined
    let videoThumbPath: string | undefined
    let emojiMd5: string | undefined
    let emojiCdnUrl: string | undefined

    const mediaDirHash = /^[0-9a-f]{32}$/i.test(sessionUsername)
      ? sessionUsername.toLowerCase()
      : this.md5(sessionUsername)
    const mediaBase = join(this.accountPath, 'Message', 'MessageTemp', mediaDirHash)

    // WeChat 3.8.x: MessageTemp filenames use "{mesLocalID}{msgCreateTime}" as prefix
    const fileIdStr = `${localId}${createTime}`

    if (msgType === 3) {
      // Image: plain JPEG files (no encryption in 3.8.x)
      const md5Match = /\bmd5="([0-9a-fA-F]{32})"/.exec(rawContent)
      if (md5Match) imageMd5 = md5Match[1]
      const hdPath = join(mediaBase, 'Image', `${fileIdStr}_.pic_hd.jpg`)
      const thumbPath = join(mediaBase, 'Image', `${fileIdStr}_.pic_thumb.jpg`)
      const plainPath = join(mediaBase, 'Image', `${fileIdStr}_.pic.jpg`)
      const hdExists = existsSync(hdPath)
      const thumbExists = existsSync(thumbPath)
      const plainExists = existsSync(plainPath)
      if (hdExists) {
        imageDatName = hdPath
      } else if (plainExists) {
        imageDatName = plainPath
      } else if (thumbExists) {
        imageDatName = thumbPath
      }
    } else if (msgType === 47) {
      // Emoji: extract md5 and cdnurl from XML content
      const md5Match = /\bmd5="([0-9a-fA-F]{32})"/i.exec(rawContent)
      if (md5Match) emojiMd5 = md5Match[1].toLowerCase()
      const cdnMatch = /\bcdnurl="([^"]+)"/i.exec(rawContent)
      if (cdnMatch && cdnMatch[1] && cdnMatch[1] !== 'null') emojiCdnUrl = cdnMatch[1]
    } else if (msgType === 43) {
      // Video: {localId}_{createTime}.mp4 or {localId}_{createTime}_raw.mp4
      const videoBase = `${localId}_${createTime}`
      const mp4Path = join(mediaBase, 'Video', `${videoBase}.mp4`)
      const rawMp4Path = join(mediaBase, 'Video', `${videoBase}_raw.mp4`)
      const thumbPath = join(mediaBase, 'Video', `${videoBase}.video_thumb.jpg`)
      if (existsSync(mp4Path)) videoLocalPath = mp4Path
      else if (existsSync(rawMp4Path)) videoLocalPath = rawMp4Path
      if (existsSync(thumbPath)) videoThumbPath = thumbPath
    } else if (msgType === 34) {
      // Voice: plain SILK files (no encryption in 3.8.x)
      const lenMatch = /\bvoicelength="(\d+)"/.exec(rawContent)
      if (lenMatch) voiceDurationSeconds = Math.round(parseInt(lenMatch[1], 10) / 1000)
      const audioDir = join(mediaBase, 'Audio')
      if (existsSync(audioDir)) {
        // WeChat 3.8.x uses "{mesLocalID}{msgCreateTime}" as filename prefix
        const prefixes = [fileIdStr, String(localId)]
        try {
          let files = this.audioDirCache.get(audioDir)
          if (!files) {
            files = readdirSync(audioDir)
            this.audioDirCache.set(audioDir, files)
          }
          for (const prefix of prefixes) {
            const match = files.find(f => f.startsWith(prefix) && f.endsWith('.aud.silk'))
            if (match) { localAudioPath = join(audioDir, match); break }
          }
        } catch {
          // ignore read errors
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    return {
      messageKey: `${sessionUsername}:${localId}`,
      localId,
      serverId,
      serverIdRaw: String(serverId),
      localType: msgType,
      createTime,
      sortSeq: createTime,
      isSend,
      senderUsername,
      parsedContent,
      rawContent,
      content: rawContent,
      ...(imageMd5 !== undefined && { imageMd5 }),
      ...(imageDatName !== undefined && { imageDatName }),
      ...(voiceDurationSeconds !== undefined && { voiceDurationSeconds }),
      ...(localAudioPath !== undefined && { localAudioPath }),
      ...(videoLocalPath !== undefined && { videoLocalPath }),
      ...(videoThumbPath !== undefined && { videoThumbPath }),
      ...(emojiMd5 !== undefined && { emojiMd5 }),
      ...(emojiCdnUrl !== undefined && { emojiCdnUrl }),
      // 4.0+ compatible field aliases used by exportService cursor pipeline
      message_content: rawContent,
      sender_username: senderUsername || '',
      computed_is_send: String(isSend),
      image_md5: imageMd5 || '',
      image_dat_name: imageDatName || '',
    }
  }

  /**
   * Returns raw SILK bytes for a voice message (3.8.x: plain .aud.silk file).
   * Returns null if not found.
   */
  getVoiceSilkData(sessionId: string, localId: number, createTime = 0): Buffer | null {
    try {
      const mediaDirHash = /^[0-9a-f]{32}$/i.test(sessionId)
        ? sessionId.toLowerCase()
        : this.md5(sessionId)
      const audioDir = join(this.accountPath, 'Message', 'MessageTemp', mediaDirHash, 'Audio')
      if (!existsSync(audioDir)) return null
      // WeChat 3.8.x uses "{mesLocalID}{msgCreateTime}" as filename prefix
      const prefixes = createTime > 0
        ? [`${localId}${createTime}`, String(localId)]
        : [String(localId)]
      let files = this.audioDirCache.get(audioDir)
      if (!files) {
        files = readdirSync(audioDir)
        this.audioDirCache.set(audioDir, files)
      }
      for (const prefix of prefixes) {
        const match = files.find(f => f.startsWith(prefix) && f.endsWith('.aud.silk'))
        if (match) return readFileSync(join(audioDir, match))
      }
      return null
    } catch {
      return null
    }
  }
}
