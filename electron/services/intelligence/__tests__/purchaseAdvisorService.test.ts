import { describe, it, expect } from 'vitest'
import { PurchaseAdvisorService, type PurchaseMessage } from '../purchaseAdvisorService'

describe('PurchaseAdvisorService', () => {
  const service = new PurchaseAdvisorService()

  function makeMsg(overrides: Partial<PurchaseMessage> = {}): PurchaseMessage {
    return {
      sender: 'Alice',
      content: '你好',
      timestamp: Date.now(),
      sessionId: 'session_1',
      isSelf: false,
      ...overrides,
    }
  }

  // ── Basic analysis ───────────────────────────────────────────

  it('generates report for empty messages', async () => {
    const result = await service.analyze([])
    expect(result.totalSpending).toBe(0)
    expect(result.topItems).toHaveLength(0)
    expect(result.insights.length).toBeGreaterThan(0)
  })

  // ── Amount extraction ────────────────────────────────────────

  it('extracts CNY amounts with ¥ symbol', async () => {
    const messages = [
      makeMsg({ content: '今天外卖花了¥35.5' }),
    ]
    const result = await service.analyze(messages)
    expect(result.totalSpending).toBe(35.5)
    expect(result.topItems).toHaveLength(1)
  })

  it('extracts amounts with 元 suffix', async () => {
    const messages = [
      makeMsg({ content: '买了本书花了128元' }),
    ]
    const result = await service.analyze(messages)
    expect(result.totalSpending).toBe(128)
  })

  it('extracts USD amounts', async () => {
    const messages = [
      makeMsg({ content: 'Bought something for $49.99' }),
    ]
    const result = await service.analyze(messages)
    expect(result.topItems[0].currency).toBe('USD')
  })

  // ── Categorization ───────────────────────────────────────────

  it('categorizes dining spending', async () => {
    const messages = [
      makeMsg({ content: '外卖到了，花了¥45' }),
    ]
    const result = await service.analyze(messages)
    expect(result.spendingByCategory['餐饮']).toBe(45)
  })

  it('categorizes education spending', async () => {
    const messages = [
      makeMsg({ content: '报了个课程，学费500元' }),
    ]
    const result = await service.analyze(messages)
    expect(result.spendingByCategory['教育']).toBe(500)
  })

  // ── Recommendations ──────────────────────────────────────────

  it('recommends reducing dining when ratio is high', async () => {
    const messages = [
      makeMsg({ content: '外卖¥50' }),
      makeMsg({ content: '午饭¥35' }),
      makeMsg({ content: '晚饭外卖¥60' }),
      makeMsg({ content: '买了个10元的东西' }),
    ]
    const result = await service.analyze(messages)
    // Dining is 145/155 = 93% of total
    expect(result.recommendations.some(r => r.category === '餐饮')).toBe(true)
  })

  // ── Insights ─────────────────────────────────────────────────

  it('generates spending insights', async () => {
    const messages = [
      makeMsg({ content: '淘宝下单了¥200' }),
      makeMsg({ content: '咖啡¥30' }),
    ]
    const result = await service.analyze(messages)
    expect(result.insights.length).toBeGreaterThan(0)
    expect(result.insights.some(i => i.includes('230'))).toBe(true)
  })
})
