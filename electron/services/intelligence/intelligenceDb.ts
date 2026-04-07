/**
 * Intelligence Database — SQLite storage for all intelligence layer data.
 *
 * Uses better-sqlite3 (synchronous API). All tables use CREATE IF NOT EXISTS
 * for safe migration. Separate from WCDB (which is read-only).
 *
 * Tables:
 *   - contacts, relationships, personality, per_contact_style (social graph)
 *   - identity_aliases (cross-platform identity resolution)
 *   - coach_log, coach_feedback, coach_discussion, coach_config (reply coach)
 *   - contact_preferences (star / ignore)
 *   - enriched_cache (media processing cache)
 *   - daily_briefing (briefing history)
 */

import Database from 'better-sqlite3'
import crypto from 'crypto'
import type {
  CoachDiscussion,
  ContactPreference,
  IdentityAlias,
  EnrichedCacheEntry,
  DailyBriefing,
  DiscussionRound,
  Relationship,
} from './types'

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    console.warn('[intelligenceDb] JSON parse failed for:', value?.slice(0, 100))
    return fallback
  }
}

// AES-256-GCM encryption for sensitive coach_log fields
const ENCRYPTION_KEY_SEED = 'weflow-intelligence-local-encryption-v1'
let _encryptionKey: Buffer | null = null

function getEncryptionKey(): Buffer {
  if (!_encryptionKey) {
    _encryptionKey = crypto.createHash('sha256').update(ENCRYPTION_KEY_SEED).digest()
  }
  return _encryptionKey
}

function encryptField(text: string): string {
  if (!text) return text
  try {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
  } catch {
    return text
  }
}

function decryptField(data: string): string {
  if (!data || !data.startsWith('enc:')) return data
  try {
    const parts = data.slice(4).split(':')
    if (parts.length !== 3) return data
    const iv = Buffer.from(parts[0], 'base64')
    const tag = Buffer.from(parts[1], 'base64')
    const encrypted = Buffer.from(parts[2], 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv)
    decipher.setAuthTag(tag)
    return decipher.update(encrypted) + decipher.final('utf8')
  } catch {
    return data
  }
}

export class IntelligenceDb {
  private db: Database.Database

  constructor(dbPathOrMemory: string = ':memory:') {
    try {
      // Ensure parent directory exists for file-based DB
      if (dbPathOrMemory !== ':memory:') {
        const path = require('path')
        const fs = require('fs')
        const dir = path.dirname(dbPathOrMemory)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
      }
      this.db = new Database(dbPathOrMemory)
    } catch (e) {
      console.warn('[intelligenceDb] Failed to open', dbPathOrMemory, '- falling back to in-memory:', e)
      this.db = new Database(':memory:')
    }
    try {
      this.db.pragma('journal_mode = WAL')
    } catch (e) {
      console.warn('[intelligenceDb] WAL mode failed, using default journal mode:', e)
    }
    try {
      this.db.pragma('foreign_keys = ON')
    } catch (e) {
      console.warn('[intelligenceDb] foreign_keys pragma failed:', e)
    }
    try {
      this._initSchema()
    } catch (e) {
      console.error('[intelligenceDb] Schema initialization failed:', e)
    }
  }

  private _initSchema(): void {
    this.db.exec(`
      -- Contacts (social graph nodes)
      CREATE TABLE IF NOT EXISTS contacts (
        name TEXT PRIMARY KEY,
        platform TEXT DEFAULT '',
        aliases TEXT DEFAULT '[]',
        relationship TEXT DEFAULT '',
        first_seen TEXT DEFAULT '',
        last_seen TEXT DEFAULT '',
        message_count INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}'
      );

      -- Relationships (social graph edges)
      CREATE TABLE IF NOT EXISTS relationships (
        contact_name TEXT PRIMARY KEY,
        relationship_type TEXT DEFAULT 'acquaintance',
        closeness REAL DEFAULT 0.0,
        communication_style TEXT DEFAULT '',
        topics TEXT DEFAULT '[]',
        dynamics TEXT DEFAULT '',
        last_updated TEXT DEFAULT ''
      );

      -- Personality profile (key-value store)
      CREATE TABLE IF NOT EXISTS personality (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT ''
      );

      -- Per-contact communication style overrides
      CREATE TABLE IF NOT EXISTS per_contact_style (
        contact_name TEXT PRIMARY KEY,
        style TEXT DEFAULT ''
      );

      -- Cross-platform identity aliases
      CREATE TABLE IF NOT EXISTS identity_aliases (
        alias TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_identity_canonical
        ON identity_aliases(canonical_name);

      -- Coach log (debug & feedback tracking)
      CREATE TABLE IF NOT EXISTS coach_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        contact TEXT NOT NULL,
        incoming_message TEXT NOT NULL,
        relationship_context TEXT DEFAULT '',
        history_context TEXT DEFAULT '',
        personality_context TEXT DEFAULT '',
        system_prompt TEXT DEFAULT '',
        user_prompt TEXT DEFAULT '',
        llm_response TEXT DEFAULT '',
        parsed_suggestions TEXT DEFAULT '[]',
        model_used TEXT DEFAULT '',
        duration_ms INTEGER DEFAULT 0,
        is_group INTEGER DEFAULT 0,
        call_type TEXT DEFAULT 'suggest'
      );
      CREATE INDEX IF NOT EXISTS idx_coach_log_ts
        ON coach_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_coach_log_contact_msg
        ON coach_log(contact, incoming_message);

      -- Coach feedback
      CREATE TABLE IF NOT EXISTS coach_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        log_id INTEGER NOT NULL,
        suggestion_index INTEGER NOT NULL,
        rating TEXT NOT NULL,
        user_rewrite TEXT DEFAULT '',
        contact TEXT DEFAULT '',
        FOREIGN KEY (log_id) REFERENCES coach_log(id)
      );
      CREATE INDEX IF NOT EXISTS idx_coach_feedback_log
        ON coach_feedback(log_id);

      -- Discussion mode sessions
      CREATE TABLE IF NOT EXISTS coach_discussion (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        incoming_message TEXT NOT NULL,
        rounds TEXT NOT NULL DEFAULT '[]',
        strategy_summary TEXT,
        status TEXT DEFAULT 'active',
        guide_questions TEXT,
        is_complex INTEGER DEFAULT 0,
        complexity_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discussion_contact
        ON coach_discussion(contact);
      CREATE INDEX IF NOT EXISTS idx_discussion_status
        ON coach_discussion(status);
      CREATE INDEX IF NOT EXISTS idx_discussion_contact_msg_status
        ON coach_discussion(contact, incoming_message, status);

      -- Coach config (key-value overrides)
      CREATE TABLE IF NOT EXISTS coach_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Contact preferences (star, ignore, priority)
      CREATE TABLE IF NOT EXISTS contact_preferences (
        contact_name TEXT PRIMARY KEY,
        is_starred INTEGER DEFAULT 0,
        is_ignored INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contact_pref_starred
        ON contact_preferences(is_starred) WHERE is_starred = 1;
      CREATE INDEX IF NOT EXISTS idx_contact_pref_ignored
        ON contact_preferences(is_ignored) WHERE is_ignored = 1;

      -- Suggestion usage tracking (E4: reply style learning)
      CREATE TABLE IF NOT EXISTS suggestion_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_name TEXT NOT NULL,
        style TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_suggestion_usage_contact
        ON suggestion_usage(contact_name);

      -- Enriched cache (media processing results)
      CREATE TABLE IF NOT EXISTS enriched_cache (
        cache_key TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        processed_content TEXT NOT NULL,
        base64_data TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_enriched_cache_type
        ON enriched_cache(media_type);

      -- Daily briefing history
      CREATE TABLE IF NOT EXISTS daily_briefing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        items TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        generated_at TEXT NOT NULL,
        model_used TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_briefing_date
        ON daily_briefing(date);
    `)
  }

  /** Close the database connection */
  close(): void {
    this.db.close()
  }

  /** Get the underlying database instance (for testing/advanced use) */
  getDb(): Database.Database {
    return this.db
  }

  // ═══════════════════════════════════════════════════════════════
  // Identity Resolution
  // ═══════════════════════════════════════════════════════════════

  addAlias(alias: string, canonicalName: string): void {
    this.db.prepare(
      `INSERT INTO identity_aliases (alias, canonical_name) VALUES (?, ?)
       ON CONFLICT(alias) DO UPDATE SET canonical_name = excluded.canonical_name`
    ).run(alias, canonicalName)
  }

  addAliasesBulk(mappings: Array<[string, string]>): void {
    const stmt = this.db.prepare(
      `INSERT INTO identity_aliases (alias, canonical_name) VALUES (?, ?)
       ON CONFLICT(alias) DO UPDATE SET canonical_name = excluded.canonical_name`
    )
    const tx = this.db.transaction(() => {
      for (const [alias, canonical] of mappings) {
        stmt.run(alias, canonical)
      }
    })
    tx()
  }

  resolve(identifier: string): string {
    let current = identifier
    const seen = new Set<string>([current])
    for (let i = 0; i < 10; i++) {
      const row = this.db.prepare(
        'SELECT canonical_name FROM identity_aliases WHERE alias = ?'
      ).get(current) as { canonical_name: string } | undefined
      if (!row) return current
      const canonical = row.canonical_name
      if (canonical === current || seen.has(canonical)) return current
      seen.add(canonical)
      current = canonical
    }
    return current
  }

  reverseResolve(canonicalName: string): string[] {
    const result: string[] = []
    const visited = new Set<string>([canonicalName])
    const queue = [canonicalName]

    while (queue.length > 0) {
      const current = queue.shift()!
      const rows = this.db.prepare(
        'SELECT alias FROM identity_aliases WHERE canonical_name = ? AND alias != ?'
      ).all(current, current) as Array<{ alias: string }>
      for (const row of rows) {
        if (!visited.has(row.alias)) {
          visited.add(row.alias)
          result.push(row.alias)
          queue.push(row.alias)
        }
      }
    }
    return result
  }

  getAliases(canonicalName: string): IdentityAlias[] {
    const rows = this.db.prepare(
      'SELECT alias, canonical_name FROM identity_aliases WHERE canonical_name = ?'
    ).all(canonicalName) as Array<{ alias: string; canonical_name: string }>
    return rows.map(r => ({ alias: r.alias, canonicalName: r.canonical_name }))
  }

  // ═══════════════════════════════════════════════════════════════
  // Contact CRUD
  // ═══════════════════════════════════════════════════════════════

  upsertContact(name: string, data: Record<string, any> = {}): void {
    this.db.prepare(`
      INSERT INTO contacts (name, platform, aliases, relationship, first_seen, last_seen, message_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        platform = excluded.platform,
        aliases = excluded.aliases,
        relationship = excluded.relationship,
        last_seen = excluded.last_seen,
        message_count = excluded.message_count,
        metadata = excluded.metadata
    `).run(
      name,
      data.platform ?? '',
      JSON.stringify(data.aliases ?? []),
      data.relationship ?? '',
      data.firstSeen ?? data.first_seen ?? '',
      data.lastSeen ?? data.last_seen ?? '',
      data.messageCount ?? data.message_count ?? 0,
      JSON.stringify(data.metadata ?? {}),
    )
  }

  getContact(name: string): Record<string, any> | null {
    const row = this.db.prepare('SELECT * FROM contacts WHERE name = ?').get(name) as any
    if (!row) return null
    return {
      ...row,
      aliases: safeJsonParse(row.aliases, []),
      metadata: safeJsonParse(row.metadata, {}),
    }
  }

  getAllContacts(): Array<Record<string, any>> {
    const rows = this.db.prepare('SELECT * FROM contacts ORDER BY message_count DESC').all() as any[]
    return rows.map(row => ({
      ...row,
      aliases: safeJsonParse(row.aliases, []),
      metadata: safeJsonParse(row.metadata, {}),
    }))
  }

  // ═══════════════════════════════════════════════════════════════
  // Relationship CRUD
  // ═══════════════════════════════════════════════════════════════

  upsertRelationship(rel: Relationship): void {
    this.db.prepare(`
      INSERT INTO relationships (contact_name, relationship_type, closeness, communication_style, topics, dynamics, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_name) DO UPDATE SET
        relationship_type = excluded.relationship_type,
        closeness = excluded.closeness,
        communication_style = excluded.communication_style,
        topics = excluded.topics,
        dynamics = excluded.dynamics,
        last_updated = excluded.last_updated
    `).run(
      rel.contact_name, rel.relationship_type, rel.closeness,
      rel.communication_style, JSON.stringify(rel.topics),
      rel.dynamics, rel.last_updated,
    )
  }

  getRelationship(contactName: string): Relationship | null {
    const row = this.db.prepare(
      'SELECT * FROM relationships WHERE contact_name = ?'
    ).get(contactName) as any
    if (!row) return null
    return {
      contact_name: row.contact_name,
      relationship_type: row.relationship_type,
      closeness: row.closeness,
      communication_style: row.communication_style,
      topics: safeJsonParse(row.topics, []),
      dynamics: row.dynamics,
      last_updated: row.last_updated,
    }
  }

  listRelationships(): Relationship[] {
    const rows = this.db.prepare(
      'SELECT * FROM relationships ORDER BY closeness DESC'
    ).all() as any[]
    return rows.map(row => ({
      contact_name: row.contact_name,
      relationship_type: row.relationship_type,
      closeness: row.closeness,
      communication_style: row.communication_style,
      topics: safeJsonParse(row.topics, []),
      dynamics: row.dynamics,
      last_updated: row.last_updated,
    }))
  }

  // ═══════════════════════════════════════════════════════════════
  // Personality
  // ═══════════════════════════════════════════════════════════════

  getPersonalityValue(key: string): string {
    const row = this.db.prepare(
      'SELECT value FROM personality WHERE key = ?'
    ).get(key) as { value: string } | undefined
    return row ? row.value : ''
  }

  setPersonalityValue(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO personality (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value)
  }

  getAllPersonalityFields(): Record<string, string> {
    const rows = this.db.prepare('SELECT * FROM personality').all() as Array<{ key: string; value: string }>
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }

  getPerContactStyle(contactName: string): string {
    const row = this.db.prepare(
      'SELECT style FROM per_contact_style WHERE contact_name = ?'
    ).get(contactName) as { style: string } | undefined
    return row ? row.style : ''
  }

  setPerContactStyle(contactName: string, style: string): void {
    this.db.prepare(
      `INSERT INTO per_contact_style (contact_name, style) VALUES (?, ?)
       ON CONFLICT(contact_name) DO UPDATE SET style = excluded.style`
    ).run(contactName, style)
  }

  // ═══════════════════════════════════════════════════════════════
  // Coach Log
  // ═══════════════════════════════════════════════════════════════

  logCoachCall(opts: {
    contact: string
    incomingMessage: string
    relationshipContext?: string
    historyContext?: string
    personalityContext?: string
    systemPrompt?: string
    userPrompt?: string
    llmResponse?: string
    parsedSuggestions?: string
    modelUsed?: string
    durationMs?: number
    isGroup?: boolean
    callType?: string
  }): number {
    const ts = new Date().toISOString()
    const result = this.db.prepare(
      `INSERT INTO coach_log
       (timestamp, contact, incoming_message, relationship_context,
        history_context, personality_context, system_prompt, user_prompt,
        llm_response, parsed_suggestions, model_used, duration_ms, is_group, call_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ts, opts.contact, encryptField(opts.incomingMessage),
      opts.relationshipContext ?? '',
      opts.historyContext ?? '',
      opts.personalityContext ?? '',
      opts.systemPrompt ?? '',
      encryptField(opts.userPrompt ?? ''),
      encryptField(opts.llmResponse ?? ''),
      opts.parsedSuggestions ?? '[]',
      opts.modelUsed ?? '',
      opts.durationMs ?? 0,
      opts.isGroup ? 1 : 0,
      opts.callType ?? 'suggest',
    )
    return Number(result.lastInsertRowid)
  }

  getCoachLog(logId: number): Record<string, any> | null {
    const row = this.db.prepare('SELECT * FROM coach_log WHERE id = ?').get(logId) as any
    if (!row) return null
    return {
      ...row,
      incoming_message: decryptField(row.incoming_message),
      user_prompt: decryptField(row.user_prompt),
      llm_response: decryptField(row.llm_response),
      parsed_suggestions: safeJsonParse(row.parsed_suggestions, []),
      is_group: Boolean(row.is_group),
    }
  }

  getCoachLogs(limit = 50, offset = 0, callType = ''): Array<Record<string, any>> {
    let rows: any[]
    if (callType) {
      rows = this.db.prepare(
        `SELECT id, timestamp, contact, incoming_message, model_used, duration_ms,
         parsed_suggestions, is_group, call_type
         FROM coach_log WHERE call_type = ? ORDER BY id DESC LIMIT ? OFFSET ?`
      ).all(callType, limit, offset) as any[]
    } else {
      rows = this.db.prepare(
        `SELECT id, timestamp, contact, incoming_message, model_used, duration_ms,
         parsed_suggestions, is_group, call_type
         FROM coach_log ORDER BY id DESC LIMIT ? OFFSET ?`
      ).all(limit, offset) as any[]
    }
    return rows.map(r => ({
      ...r,
      suggestion_count: safeJsonParse(r.parsed_suggestions, []).length,
      is_group: Boolean(r.is_group),
    }))
  }

  getCachedCoachLog(contact: string, incomingMessage: string, maxAgeHours = 24, isGroup = false): Record<string, any> | null {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString()
    const row = this.db.prepare(
      `SELECT id, parsed_suggestions, relationship_context, personality_context,
       timestamp, model_used, duration_ms
       FROM coach_log
       WHERE contact = ? AND incoming_message = ? AND is_group = ? AND timestamp > ?
       ORDER BY id DESC LIMIT 1`
    ).get(contact, incomingMessage, isGroup ? 1 : 0, cutoff) as any
    return row ? { ...row } : null
  }

  // ═══════════════════════════════════════════════════════════════
  // Coach Feedback
  // ═══════════════════════════════════════════════════════════════

  addCoachFeedback(logId: number, suggestionIndex: number, rating: string, contact = '', userRewrite = ''): number {
    const ts = new Date().toISOString()
    const result = this.db.prepare(
      `INSERT INTO coach_feedback (timestamp, log_id, suggestion_index, rating, user_rewrite, contact)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(ts, logId, suggestionIndex, rating, userRewrite, contact)
    return Number(result.lastInsertRowid)
  }

  getFeedbackForLog(logId: number): Array<Record<string, any>> {
    return this.db.prepare(
      'SELECT * FROM coach_feedback WHERE log_id = ? ORDER BY id'
    ).all(logId) as any[]
  }

  getRecentFeedback(contact: string, limit = 20): Array<Record<string, any>> {
    if (contact) {
      return this.db.prepare(
        'SELECT * FROM coach_feedback WHERE contact = ? ORDER BY id DESC LIMIT ?'
      ).all(contact, limit) as any[]
    }
    return this.db.prepare(
      'SELECT * FROM coach_feedback ORDER BY id DESC LIMIT ?'
    ).all(limit) as any[]
  }

  // ═══════════════════════════════════════════════════════════════
  // Discussion CRUD
  // ═══════════════════════════════════════════════════════════════

  createDiscussion(contact: string, incomingMessage: string, opts?: {
    isComplex?: boolean
    complexityReason?: string
    guideQuestions?: string[]
  }): number {
    const now = new Date().toISOString()
    const result = this.db.prepare(
      `INSERT INTO coach_discussion
       (contact, incoming_message, is_complex, complexity_reason, guide_questions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      contact,
      incomingMessage,
      opts?.isComplex ? 1 : 0,
      opts?.complexityReason ?? '',
      JSON.stringify(opts?.guideQuestions ?? []),
      now, now,
    )
    return Number(result.lastInsertRowid)
  }

  getDiscussion(discussionId: number): CoachDiscussion | null {
    const row = this.db.prepare(
      'SELECT * FROM coach_discussion WHERE id = ?'
    ).get(discussionId) as any
    if (!row) return null
    return this._rowToDiscussion(row)
  }

  findActiveDiscussion(contact: string, message: string): CoachDiscussion | null {
    const row = this.db.prepare(
      `SELECT * FROM coach_discussion
       WHERE contact = ? AND incoming_message = ? AND status = 'active'
       ORDER BY id DESC LIMIT 1`
    ).get(contact, message) as any
    if (!row) return null
    return this._rowToDiscussion(row)
  }

  getActiveDiscussions(): CoachDiscussion[] {
    const rows = this.db.prepare(
      `SELECT * FROM coach_discussion WHERE status = 'active' ORDER BY updated_at DESC`
    ).all() as any[]
    return rows.map(r => this._rowToDiscussion(r))
  }

  appendDiscussionRound(discussionId: number, role: string, content: string): void {
    const row = this.db.prepare(
      'SELECT rounds FROM coach_discussion WHERE id = ?'
    ).get(discussionId) as { rounds: string } | undefined
    if (!row) return

    const rounds = safeJsonParse(row.rounds, [])
    rounds.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    })
    const now = new Date().toISOString()
    this.db.prepare(
      'UPDATE coach_discussion SET rounds = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(rounds), now, discussionId)
  }

  updateDiscussionStatus(discussionId: number, status: string, strategySummary?: string): void {
    const now = new Date().toISOString()
    if (strategySummary !== undefined) {
      this.db.prepare(
        'UPDATE coach_discussion SET status = ?, strategy_summary = ?, updated_at = ? WHERE id = ?'
      ).run(status, strategySummary, now, discussionId)
    } else {
      this.db.prepare(
        'UPDATE coach_discussion SET status = ?, updated_at = ? WHERE id = ?'
      ).run(status, now, discussionId)
    }
  }

  completeDiscussion(discussionId: number, strategySummary = ''): void {
    this.updateDiscussionStatus(discussionId, 'completed', strategySummary)
  }

  abandonDiscussion(discussionId: number): void {
    this.updateDiscussionStatus(discussionId, 'cancelled')
  }

  private _rowToDiscussion(row: any): CoachDiscussion {
    return {
      id: row.id,
      contact: row.contact,
      incomingMessage: row.incoming_message,
      rounds: safeJsonParse(row.rounds, []),
      strategySummary: row.strategy_summary,
      status: row.status,
      guideQuestions: safeJsonParse(row.guide_questions, []),
      isComplex: Boolean(row.is_complex),
      complexityReason: row.complexity_reason || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Coach Config
  // ═══════════════════════════════════════════════════════════════

  getCoachConfig(key: string): string | null {
    const row = this.db.prepare(
      'SELECT value FROM coach_config WHERE key = ?'
    ).get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  setCoachConfig(key: string, value: string): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO coach_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, now)
  }

  // ═══════════════════════════════════════════════════════════════
  // Contact Preferences (star / ignore)
  // ═══════════════════════════════════════════════════════════════

  starContact(contactName: string): ContactPreference | null {
    return this.setContactPreference(contactName, 'star')
  }

  unstarContact(contactName: string): ContactPreference | null {
    return this.setContactPreference(contactName, 'unstar')
  }

  ignoreContact(contactName: string): ContactPreference | null {
    return this.setContactPreference(contactName, 'ignore')
  }

  unignoreContact(contactName: string): ContactPreference | null {
    return this.setContactPreference(contactName, 'unignore')
  }

  setContactPreference(contactName: string, action: 'star' | 'unstar' | 'ignore' | 'unignore'): ContactPreference | null {
    const now = new Date().toISOString()
    if (action === 'star') {
      this.db.prepare(
        `INSERT INTO contact_preferences (contact_name, is_starred, is_ignored, priority, updated_at)
         VALUES (?, 1, 0, 0, ?)
         ON CONFLICT(contact_name) DO UPDATE SET is_starred=1, is_ignored=0, updated_at=?`
      ).run(contactName, now, now)
    } else if (action === 'unstar') {
      this.db.prepare(
        `INSERT INTO contact_preferences (contact_name, is_starred, is_ignored, priority, updated_at)
         VALUES (?, 0, 0, 0, ?)
         ON CONFLICT(contact_name) DO UPDATE SET is_starred=0, updated_at=?`
      ).run(contactName, now, now)
    } else if (action === 'ignore') {
      this.db.prepare(
        `INSERT INTO contact_preferences (contact_name, is_starred, is_ignored, priority, updated_at)
         VALUES (?, 0, 1, 0, ?)
         ON CONFLICT(contact_name) DO UPDATE SET is_ignored=1, is_starred=0, updated_at=?`
      ).run(contactName, now, now)
    } else if (action === 'unignore') {
      this.db.prepare(
        `INSERT INTO contact_preferences (contact_name, is_starred, is_ignored, priority, updated_at)
         VALUES (?, 0, 0, 0, ?)
         ON CONFLICT(contact_name) DO UPDATE SET is_ignored=0, updated_at=?`
      ).run(contactName, now, now)
    }
    return this.getContactPreference(contactName)
  }

  getContactPreference(contactName: string): ContactPreference | null {
    const row = this.db.prepare(
      'SELECT * FROM contact_preferences WHERE contact_name = ?'
    ).get(contactName) as any
    if (!row) return null
    return {
      contactName: row.contact_name,
      isStarred: Boolean(row.is_starred),
      isIgnored: Boolean(row.is_ignored),
      priority: row.priority,
      updatedAt: row.updated_at,
    }
  }

  getStarredContacts(): ContactPreference[] {
    const rows = this.db.prepare(
      'SELECT * FROM contact_preferences WHERE is_starred = 1 ORDER BY updated_at DESC'
    ).all() as any[]
    return rows.map(r => ({
      contactName: r.contact_name,
      isStarred: Boolean(r.is_starred),
      isIgnored: Boolean(r.is_ignored),
      priority: r.priority,
      updatedAt: r.updated_at,
    }))
  }

  getIgnoredContacts(): ContactPreference[] {
    const rows = this.db.prepare(
      'SELECT * FROM contact_preferences WHERE is_ignored = 1 ORDER BY updated_at DESC'
    ).all() as any[]
    return rows.map(r => ({
      contactName: r.contact_name,
      isStarred: Boolean(r.is_starred),
      isIgnored: Boolean(r.is_ignored),
      priority: r.priority,
      updatedAt: r.updated_at,
    }))
  }

  getPreferenceSets(): { starred: Set<string>; ignored: Set<string> } {
    const rows = this.db.prepare(
      'SELECT contact_name, is_starred, is_ignored FROM contact_preferences'
    ).all() as Array<{ contact_name: string; is_starred: number; is_ignored: number }>
    const starred = new Set<string>()
    const ignored = new Set<string>()
    for (const r of rows) {
      if (r.is_starred) starred.add(r.contact_name)
      if (r.is_ignored) ignored.add(r.contact_name)
    }
    return { starred, ignored }
  }

  // ═══════════════════════════════════════════════════════════════
  // Enriched Cache
  // ═══════════════════════════════════════════════════════════════

  getCachedEnrichment(cacheKey: string): EnrichedCacheEntry | null {
    const row = this.db.prepare(
      'SELECT * FROM enriched_cache WHERE cache_key = ?'
    ).get(cacheKey) as any
    if (!row) return null
    // Check expiration
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      this.db.prepare('DELETE FROM enriched_cache WHERE cache_key = ?').run(cacheKey)
      return null
    }
    return {
      cacheKey: row.cache_key,
      mediaType: row.media_type,
      processedContent: row.processed_content,
      base64Data: row.base64_data,
      metadata: safeJsonParse(row.metadata, {}),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  setCachedEnrichment(cacheKey: string, data: {
    mediaType: string
    processedContent: string
    base64Data?: string | null
    metadata?: Record<string, any>
    expiresAt?: string | null
  }): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO enriched_cache (cache_key, media_type, processed_content, base64_data, metadata, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         processed_content = excluded.processed_content,
         base64_data = excluded.base64_data,
         metadata = excluded.metadata,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    ).run(
      cacheKey,
      data.mediaType,
      data.processedContent,
      data.base64Data ?? null,
      JSON.stringify(data.metadata ?? {}),
      now,
      data.expiresAt ?? null,
    )
  }

  invalidateCache(cacheKey: string): void {
    this.db.prepare('DELETE FROM enriched_cache WHERE cache_key = ?').run(cacheKey)
  }

  invalidateCacheByType(mediaType: string): void {
    this.db.prepare('DELETE FROM enriched_cache WHERE media_type = ?').run(mediaType)
  }

  // ═══════════════════════════════════════════════════════════════
  // Daily Briefing
  // ═══════════════════════════════════════════════════════════════

  saveBriefing(briefing: DailyBriefing): void {
    this.db.prepare(
      `INSERT INTO daily_briefing (date, items, summary, generated_at, model_used)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         items = excluded.items,
         summary = excluded.summary,
         generated_at = excluded.generated_at,
         model_used = excluded.model_used`
    ).run(
      briefing.date,
      JSON.stringify(briefing.items),
      briefing.summary,
      briefing.generatedAt,
      briefing.modelUsed,
    )
  }

  getBriefing(date: string): DailyBriefing | null {
    const row = this.db.prepare(
      'SELECT * FROM daily_briefing WHERE date = ?'
    ).get(date) as any
    if (!row) return null
    return this._rowToBriefing(row)
  }

  getLatestBriefing(): DailyBriefing | null {
    const row = this.db.prepare(
      'SELECT * FROM daily_briefing ORDER BY date DESC LIMIT 1'
    ).get() as any
    if (!row) return null
    return this._rowToBriefing(row)
  }

  private _rowToBriefing(row: any): DailyBriefing {
    return {
      date: row.date,
      items: safeJsonParse(row.items, []),
      summary: row.summary || '',
      generatedAt: row.generated_at,
      modelUsed: row.model_used || '',
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Data Cleanup / Maintenance
  // ═══════════════════════════════════════════════════════════════

  /** Remove expired enriched_cache entries (default: older than 7 days) */
  cleanExpiredCache(maxAgeDays = 7): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000).toISOString()
    const result = this.db.prepare(
      `DELETE FROM enriched_cache WHERE
       (expires_at IS NOT NULL AND expires_at < datetime('now'))
       OR (expires_at IS NULL AND created_at < ?)`
    ).run(cutoff)
    return result.changes
  }

  /** Remove old daily_briefing entries (default: older than 30 days) */
  cleanOldBriefings(maxAgeDays = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const result = this.db.prepare(
      'DELETE FROM daily_briefing WHERE date < ?'
    ).run(cutoff)
    return result.changes
  }

  /** Remove old completed discussions (default: older than 90 days) */
  cleanOldDiscussions(maxAgeDays = 90): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000).toISOString()
    const result = this.db.prepare(
      `DELETE FROM coach_discussion WHERE status IN ('completed', 'cancelled') AND updated_at < ?`
    ).run(cutoff)
    return result.changes
  }

  // ═══════════════════════════════════════════════════════════════
  // Suggestion Usage (E4: Reply Style Learning)
  // ═══════════════════════════════════════════════════════════════

  recordSuggestionUsage(contactName: string, style: string, action: string): void {
    this.db.prepare(
      'INSERT INTO suggestion_usage (contact_name, style, action, timestamp) VALUES (?, ?, ?, ?)'
    ).run(contactName, style, action, new Date().toISOString())
  }

  getStylePreference(contactName: string): { preferred: string; count: number } | null {
    const rows = this.db.prepare(
      `SELECT style, COUNT(*) as cnt FROM suggestion_usage
       WHERE contact_name = ? AND action IN ('copy', 'apply', 'edit')
       GROUP BY style ORDER BY cnt DESC LIMIT 1`
    ).all(contactName) as Array<{ style: string; cnt: number }>
    if (!rows.length) return null
    const total = this.db.prepare(
      `SELECT COUNT(*) as total FROM suggestion_usage
       WHERE contact_name = ? AND action IN ('copy', 'apply', 'edit')`
    ).get(contactName) as { total: number }
    if (total.total < 5) return null // Need at least 5 data points
    return { preferred: rows[0].style, count: rows[0].cnt }
  }

  /** Remove old coach logs (default: older than 30 days) */
  cleanOldCoachLogs(maxAgeDays = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000).toISOString()
    // Delete feedback first (foreign key)
    this.db.prepare(
      `DELETE FROM coach_feedback WHERE log_id IN (SELECT id FROM coach_log WHERE timestamp < ?)`
    ).run(cutoff)
    const result = this.db.prepare(
      'DELETE FROM coach_log WHERE timestamp < ?'
    ).run(cutoff)
    return result.changes
  }

  /** Run all cleanup tasks */
  runMaintenance(): { cache: number; briefings: number; discussions: number; coachLogs: number } {
    return {
      cache: this.cleanExpiredCache(),
      briefings: this.cleanOldBriefings(),
      discussions: this.cleanOldDiscussions(),
      coachLogs: this.cleanOldCoachLogs(),
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Stubs (for forward compat with existing callers)
  // ═══════════════════════════════════════════════════════════════

  saveFingerprintSnapshot(_snapshot: any): number { return 0 }
  getLatestSnapshot(): any | null { return null }
  getSnapshotHistory(_limit = 10): any[] { return [] }
  saveDriftEvent(_event: any): number { return 0 }

  private _socialGoals: Map<string, any> = new Map()

  createSocialGoal(goal: { id: string; label: string; keywords: string[]; priority: string }): void {
    this._socialGoals.set(goal.id, goal)
  }

  listSocialGoals(): any[] {
    return Array.from(this._socialGoals.values())
  }

  deleteSocialGoal(goalId: string): boolean {
    return this._socialGoals.delete(goalId)
  }
}

/** Singleton for production use — call initializeIntelligenceDb(path) in main.ts before use */
let _instance: IntelligenceDb | null = null

export function initializeIntelligenceDb(dbPath: string): IntelligenceDb {
  if (_instance) {
    return _instance
  }
  _instance = new IntelligenceDb(dbPath)
  return _instance
}

export const intelligenceDb: IntelligenceDb = new Proxy({} as IntelligenceDb, {
  get(_target, prop) {
    if (!_instance) {
      // Fallback to in-memory for tests or when not yet initialized
      _instance = new IntelligenceDb()
    }
    return (_instance as any)[prop]
  },
})
