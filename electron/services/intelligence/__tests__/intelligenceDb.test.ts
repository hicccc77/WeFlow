import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IntelligenceDb } from '../intelligenceDb'

describe('IntelligenceDb', () => {
  let db: IntelligenceDb

  beforeEach(() => {
    db = new IntelligenceDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  // ── Schema ───────────────────────────────────────────────────

  it('creates all tables on initialization', () => {
    const tables = db.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    expect(names).toContain('contacts')
    expect(names).toContain('relationships')
    expect(names).toContain('personality')
    expect(names).toContain('per_contact_style')
    expect(names).toContain('identity_aliases')
    expect(names).toContain('coach_log')
    expect(names).toContain('coach_feedback')
    expect(names).toContain('coach_discussion')
    expect(names).toContain('coach_config')
    expect(names).toContain('contact_preferences')
    expect(names).toContain('enriched_cache')
    expect(names).toContain('daily_briefing')
  })

  // ── Identity Resolution ──────────────────────────────────────

  describe('identity aliases', () => {
    it('resolves alias to canonical name', () => {
      db.addAlias('wxid_abc', 'Alice')
      expect(db.resolve('wxid_abc')).toBe('Alice')
    })

    it('returns identifier when no alias exists', () => {
      expect(db.resolve('unknown')).toBe('unknown')
    })

    it('follows alias chains', () => {
      db.addAlias('wxid_abc', 'Alice_WeChat')
      db.addAlias('Alice_WeChat', 'Alice')
      expect(db.resolve('wxid_abc')).toBe('Alice')
    })

    it('handles cycles without infinite loop', () => {
      db.addAlias('a', 'b')
      db.addAlias('b', 'a')
      const result = db.resolve('a')
      expect(['a', 'b']).toContain(result)
    })

    it('bulk adds aliases', () => {
      db.addAliasesBulk([
        ['wxid_1', 'Bob'],
        ['wxid_2', 'Carol'],
      ])
      expect(db.resolve('wxid_1')).toBe('Bob')
      expect(db.resolve('wxid_2')).toBe('Carol')
    })

    it('reverse resolves canonical name to aliases', () => {
      db.addAlias('wxid_abc', 'Alice')
      db.addAlias('alice_work', 'Alice')
      const aliases = db.reverseResolve('Alice')
      expect(aliases).toContain('wxid_abc')
      expect(aliases).toContain('alice_work')
    })

    it('getAliases returns aliases for canonical name', () => {
      db.addAlias('wxid_abc', 'Alice')
      const aliases = db.getAliases('Alice')
      expect(aliases).toHaveLength(1)
      expect(aliases[0].alias).toBe('wxid_abc')
      expect(aliases[0].canonicalName).toBe('Alice')
    })
  })

  // ── Contacts ─────────────────────────────────────────────────

  describe('contacts', () => {
    it('upserts and retrieves a contact', () => {
      db.upsertContact('Alice', { platform: 'wechat', messageCount: 50 })
      const c = db.getContact('Alice')
      expect(c).not.toBeNull()
      expect(c!.name).toBe('Alice')
      expect(c!.platform).toBe('wechat')
      expect(c!.message_count).toBe(50)
    })

    it('returns null for unknown contact', () => {
      expect(db.getContact('Nobody')).toBeNull()
    })

    it('lists all contacts sorted by message count', () => {
      db.upsertContact('Alice', { messageCount: 100 })
      db.upsertContact('Bob', { messageCount: 200 })
      const contacts = db.getAllContacts()
      expect(contacts).toHaveLength(2)
      expect(contacts[0].name).toBe('Bob')
    })
  })

  // ── Relationships ────────────────────────────────────────────

  describe('relationships', () => {
    it('upserts and retrieves a relationship', () => {
      db.upsertRelationship({
        contact_name: 'Alice',
        relationship_type: 'friend',
        closeness: 0.8,
        communication_style: 'casual',
        topics: ['travel', 'food'],
        dynamics: 'close friend',
        last_updated: '2024-01-01',
      })
      const rel = db.getRelationship('Alice')
      expect(rel).not.toBeNull()
      expect(rel!.relationship_type).toBe('friend')
      expect(rel!.closeness).toBe(0.8)
      expect(rel!.topics).toEqual(['travel', 'food'])
    })

    it('lists relationships sorted by closeness', () => {
      db.upsertRelationship({ contact_name: 'Alice', relationship_type: 'friend', closeness: 0.5, communication_style: '', topics: [], dynamics: '', last_updated: '' })
      db.upsertRelationship({ contact_name: 'Bob', relationship_type: 'colleague', closeness: 0.9, communication_style: '', topics: [], dynamics: '', last_updated: '' })
      const rels = db.listRelationships()
      expect(rels[0].contact_name).toBe('Bob')
    })
  })

  // ── Coach Discussion ─────────────────────────────────────────

  describe('coach discussion', () => {
    it('creates and retrieves a discussion', () => {
      const id = db.createDiscussion('Alice', 'How are you?')
      const disc = db.getDiscussion(id)
      expect(disc).not.toBeNull()
      expect(disc!.contact).toBe('Alice')
      expect(disc!.status).toBe('active')
      expect(disc!.rounds).toEqual([])
    })

    it('appends rounds to a discussion', () => {
      const id = db.createDiscussion('Alice', 'Hello')
      db.appendDiscussionRound(id, 'user', 'My response')
      db.appendDiscussionRound(id, 'assistant', 'AI analysis')
      const disc = db.getDiscussion(id)
      expect(disc!.rounds).toHaveLength(2)
      expect(disc!.rounds[0]).toHaveProperty('role', 'user')
      expect(disc!.rounds[1]).toHaveProperty('role', 'assistant')
    })

    it('completes a discussion', () => {
      const id = db.createDiscussion('Alice', 'Test')
      db.completeDiscussion(id, 'Strategy summary')
      const disc = db.getDiscussion(id)
      expect(disc!.status).toBe('completed')
      expect(disc!.strategySummary).toBe('Strategy summary')
    })

    it('finds active discussion', () => {
      db.createDiscussion('Alice', 'Hello')
      const found = db.findActiveDiscussion('Alice', 'Hello')
      expect(found).not.toBeNull()
      expect(found!.contact).toBe('Alice')
    })

    it('returns null for no active discussion', () => {
      expect(db.findActiveDiscussion('Nobody', 'Test')).toBeNull()
    })

    it('gets all active discussions', () => {
      db.createDiscussion('Alice', 'Hello')
      db.createDiscussion('Bob', 'Hi')
      const id3 = db.createDiscussion('Carol', 'Hey')
      db.completeDiscussion(id3)
      const active = db.getActiveDiscussions()
      expect(active).toHaveLength(2)
    })
  })

  // ── Contact Preferences ──────────────────────────────────────

  describe('contact preferences', () => {
    it('stars a contact', () => {
      const pref = db.starContact('Alice')
      expect(pref).not.toBeNull()
      expect(pref!.isStarred).toBe(true)
      expect(pref!.isIgnored).toBe(false)
    })

    it('ignores a contact (auto-unstars)', () => {
      db.starContact('Alice')
      const pref = db.ignoreContact('Alice')
      expect(pref!.isStarred).toBe(false)
      expect(pref!.isIgnored).toBe(true)
    })

    it('unstars a contact', () => {
      db.starContact('Alice')
      const pref = db.unstarContact('Alice')
      expect(pref!.isStarred).toBe(false)
    })

    it('unignores a contact', () => {
      db.ignoreContact('Alice')
      const pref = db.unignoreContact('Alice')
      expect(pref!.isIgnored).toBe(false)
    })

    it('gets starred contacts list', () => {
      db.starContact('Alice')
      db.starContact('Bob')
      db.ignoreContact('Carol')
      const starred = db.getStarredContacts()
      expect(starred).toHaveLength(2)
    })

    it('gets ignored contacts list', () => {
      db.ignoreContact('Spammer')
      const ignored = db.getIgnoredContacts()
      expect(ignored).toHaveLength(1)
      expect(ignored[0].contactName).toBe('Spammer')
    })

    it('gets preference sets for fast lookup', () => {
      db.starContact('Alice')
      db.ignoreContact('Spammer')
      const { starred, ignored } = db.getPreferenceSets()
      expect(starred.has('Alice')).toBe(true)
      expect(ignored.has('Spammer')).toBe(true)
    })
  })

  // ── Enriched Cache ───────────────────────────────────────────

  describe('enriched cache', () => {
    it('sets and gets cached enrichment', () => {
      db.setCachedEnrichment('img_123', {
        mediaType: 'image',
        processedContent: '[图片] 一只猫',
        base64Data: 'base64data...',
      })
      const entry = db.getCachedEnrichment('img_123')
      expect(entry).not.toBeNull()
      expect(entry!.mediaType).toBe('image')
      expect(entry!.processedContent).toBe('[图片] 一只猫')
    })

    it('returns null for cache miss', () => {
      expect(db.getCachedEnrichment('nonexistent')).toBeNull()
    })

    it('invalidates specific cache entry', () => {
      db.setCachedEnrichment('img_123', { mediaType: 'image', processedContent: 'test' })
      db.invalidateCache('img_123')
      expect(db.getCachedEnrichment('img_123')).toBeNull()
    })

    it('invalidates cache by type', () => {
      db.setCachedEnrichment('img_1', { mediaType: 'image', processedContent: 'a' })
      db.setCachedEnrichment('img_2', { mediaType: 'image', processedContent: 'b' })
      db.setCachedEnrichment('voice_1', { mediaType: 'voice', processedContent: 'c' })
      db.invalidateCacheByType('image')
      expect(db.getCachedEnrichment('img_1')).toBeNull()
      expect(db.getCachedEnrichment('voice_1')).not.toBeNull()
    })

    it('returns null for expired cache entries', () => {
      db.setCachedEnrichment('old_key', {
        mediaType: 'image',
        processedContent: 'old data',
        expiresAt: '2020-01-01T00:00:00Z',
      })
      expect(db.getCachedEnrichment('old_key')).toBeNull()
    })
  })

  // ── Daily Briefing ───────────────────────────────────────────

  describe('daily briefing', () => {
    it('saves and retrieves a briefing by date', () => {
      db.saveBriefing({
        date: '2024-03-15',
        items: [{ category: 'unreplied', title: 'Test', detail: 'Detail', sourcePlatform: 'wechat', contact: 'Alice', priority: 0, recordId: '' }],
        summary: 'One important thing today',
        generatedAt: '2024-03-15T08:00:00Z',
        modelUsed: 'claude-3',
      })
      const b = db.getBriefing('2024-03-15')
      expect(b).not.toBeNull()
      expect(b!.items).toHaveLength(1)
      expect(b!.summary).toBe('One important thing today')
    })

    it('gets the latest briefing', () => {
      db.saveBriefing({ date: '2024-03-14', items: [], summary: 'day 1', generatedAt: '', modelUsed: '' })
      db.saveBriefing({ date: '2024-03-15', items: [], summary: 'day 2', generatedAt: '', modelUsed: '' })
      const latest = db.getLatestBriefing()
      expect(latest!.date).toBe('2024-03-15')
      expect(latest!.summary).toBe('day 2')
    })

    it('returns null when no briefings exist', () => {
      expect(db.getLatestBriefing()).toBeNull()
    })

    it('upserts briefing for same date', () => {
      db.saveBriefing({ date: '2024-03-15', items: [], summary: 'v1', generatedAt: '', modelUsed: '' })
      db.saveBriefing({ date: '2024-03-15', items: [], summary: 'v2', generatedAt: '', modelUsed: '' })
      const b = db.getBriefing('2024-03-15')
      expect(b!.summary).toBe('v2')
    })
  })

  // ── Coach Log ────────────────────────────────────────────────

  describe('coach log', () => {
    it('logs a coach call and retrieves it', () => {
      const id = db.logCoachCall({
        contact: 'Alice',
        incomingMessage: 'Hello',
        modelUsed: 'claude-3',
        durationMs: 500,
      })
      const log = db.getCoachLog(id)
      expect(log).not.toBeNull()
      expect(log!.contact).toBe('Alice')
      expect(log!.model_used).toBe('claude-3')
    })

    it('lists coach logs with pagination', () => {
      for (let i = 0; i < 5; i++) {
        db.logCoachCall({ contact: `Contact${i}`, incomingMessage: 'test' })
      }
      const logs = db.getCoachLogs(3, 0)
      expect(logs).toHaveLength(3)
    })
  })

  // ── Coach Feedback ───────────────────────────────────────────

  describe('coach feedback', () => {
    it('adds and retrieves feedback', () => {
      const logId = db.logCoachCall({ contact: 'Alice', incomingMessage: 'test' })
      db.addCoachFeedback(logId, 0, 'good', 'Alice')
      const feedback = db.getFeedbackForLog(logId)
      expect(feedback).toHaveLength(1)
      expect(feedback[0].rating).toBe('good')
    })
  })

  // ── Maintenance ──────────────────────────────────────────────

  describe('maintenance', () => {
    it('cleans expired cache entries', () => {
      db.setCachedEnrichment('old', {
        mediaType: 'image',
        processedContent: 'old',
        expiresAt: '2020-01-01T00:00:00Z',
      })
      db.setCachedEnrichment('new', {
        mediaType: 'image',
        processedContent: 'new',
      })
      const cleaned = db.cleanExpiredCache(7)
      expect(cleaned).toBeGreaterThanOrEqual(1)
      expect(db.getCachedEnrichment('new')).not.toBeNull()
    })

    it('runMaintenance returns cleanup counts', () => {
      const result = db.runMaintenance()
      expect(result).toHaveProperty('cache')
      expect(result).toHaveProperty('briefings')
      expect(result).toHaveProperty('discussions')
    })
  })

  // ── Personality ──────────────────────────────────────────────

  describe('personality', () => {
    it('sets and gets personality value', () => {
      db.setPersonalityValue('overall_style', 'casual and friendly')
      expect(db.getPersonalityValue('overall_style')).toBe('casual and friendly')
    })

    it('returns empty string for unknown key', () => {
      expect(db.getPersonalityValue('nonexistent')).toBe('')
    })

    it('gets all personality fields', () => {
      db.setPersonalityValue('style', 'casual')
      db.setPersonalityValue('emoji', 'high')
      const fields = db.getAllPersonalityFields()
      expect(fields.style).toBe('casual')
      expect(fields.emoji).toBe('high')
    })
  })

  // ── Per-contact Style ────────────────────────────────────────

  describe('per-contact style', () => {
    it('sets and gets per-contact style', () => {
      db.setPerContactStyle('Boss', 'formal and respectful')
      expect(db.getPerContactStyle('Boss')).toBe('formal and respectful')
    })

    it('returns empty string for unknown contact', () => {
      expect(db.getPerContactStyle('Unknown')).toBe('')
    })
  })

  // ── Coach Config ─────────────────────────────────────────────

  describe('coach config', () => {
    it('sets and gets config value', () => {
      db.setCoachConfig('max_rounds', '5')
      expect(db.getCoachConfig('max_rounds')).toBe('5')
    })

    it('returns null for unknown key', () => {
      expect(db.getCoachConfig('nonexistent')).toBeNull()
    })
  })
})
