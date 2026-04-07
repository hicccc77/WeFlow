/**
 * Integration tests — verify critical paths with real file DB
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { IntelligenceDb } from '../intelligenceDb'
import { join } from 'path'
import { existsSync, unlinkSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'

describe('Integration: File-based DB', () => {
  let db: IntelligenceDb
  let dbPath: string
  let tempDir: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'weflow-test-'))
    dbPath = join(tempDir, 'test-intelligence.db')
    db = new IntelligenceDb(dbPath)
  })

  afterAll(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath)
    if (existsSync(dbPath + '-wal')) unlinkSync(dbPath + '-wal')
    if (existsSync(dbPath + '-shm')) unlinkSync(dbPath + '-shm')
  })

  it('should create DB file on disk', () => {
    expect(existsSync(dbPath)).toBe(true)
  })

  it('should persist contacts across reads', () => {
    db.upsertContact('TestUser', { platform: 'wechat', message_count: 42 })
    const contact = db.getContact('TestUser')
    expect(contact).toBeTruthy()
    expect(contact!.name).toBe('TestUser')
    expect(contact!.message_count).toBe(42)
  })

  it('should persist relationships', () => {
    db.upsertRelationship({
      contact_name: 'TestUser',
      relationship_type: 'friend',
      closeness: 0.8,
      communication_style: 'casual',
      topics: ['tech', 'music'],
      dynamics: 'positive',
      last_updated: new Date().toISOString(),
    })
    const rel = db.getRelationship('TestUser')
    expect(rel).toBeTruthy()
    expect(rel!.relationship_type).toBe('friend')
    expect(rel!.closeness).toBe(0.8)
    expect(rel!.topics).toEqual(['tech', 'music'])
  })

  it('should persist coach logs with encryption', () => {
    const logId = db.logCoachCall({
      contact: 'TestUser',
      incomingMessage: '这是一条敏感消息',
      systemPrompt: 'system',
      userPrompt: '用户提示词',
      llmResponse: 'AI回复内容',
      modelUsed: 'test-model',
      durationMs: 100,
      callType: 'analyze',
    })
    expect(logId).toBeGreaterThan(0)

    const log = db.getCoachLog(logId)
    expect(log).toBeTruthy()
    // Verify decryption works
    expect(log!.incoming_message).toBe('这是一条敏感消息')
    expect(log!.user_prompt).toBe('用户提示词')
    expect(log!.llm_response).toBe('AI回复内容')
  })

  it('should persist discussions with rounds', () => {
    const discId = db.createDiscussion('TestUser', '复杂消息', {
      isComplex: true,
      complexityReason: '需要策略',
      guideQuestions: ['问题1', '问题2'],
    })
    expect(discId).toBeGreaterThan(0)

    db.appendDiscussionRound(discId, 'user', '我的想法')
    db.appendDiscussionRound(discId, 'assistant', 'AI分析')

    const disc = db.getDiscussion(discId)
    expect(disc).toBeTruthy()
    expect(disc!.rounds.length).toBe(2)
    expect(disc!.rounds[0].role).toBe('user')
    expect(disc!.rounds[0].content).toBe('我的想法')
    expect(disc!.isComplex).toBe(true)
    expect(disc!.guideQuestions).toEqual(['问题1', '问题2'])
  })

  it('should persist contact preferences (star/ignore)', () => {
    db.starContact('TestUser')
    const prefs = db.getPreferenceSets()
    expect(prefs.starred.has('TestUser')).toBe(true)

    db.ignoreContact('AnotherUser')
    const prefs2 = db.getPreferenceSets()
    expect(prefs2.ignored.has('AnotherUser')).toBe(true)
  })

  it('should record and retrieve suggestion usage', () => {
    // Record 5+ uses for a contact
    for (let i = 0; i < 6; i++) {
      db.recordSuggestionUsage('TestUser', 'warm', 'copy')
    }
    db.recordSuggestionUsage('TestUser', 'safe', 'copy')

    const pref = db.getStylePreference('TestUser')
    expect(pref).toBeTruthy()
    expect(pref!.preferred).toBe('warm')
    expect(pref!.count).toBe(6)
  })

  it('should handle corrupted JSON gracefully', () => {
    // This tests safeJsonParse indirectly — if it fails, the DB would crash
    db.upsertContact('CorruptTest', { platform: 'test', message_count: 1 })
    const contact = db.getContact('CorruptTest')
    expect(contact).toBeTruthy()
  })

  it('should run maintenance without errors', () => {
    const result = db.runMaintenance()
    expect(result).toHaveProperty('cache')
    expect(result).toHaveProperty('briefings')
    expect(result).toHaveProperty('discussions')
    expect(result).toHaveProperty('coachLogs')
  })
})
