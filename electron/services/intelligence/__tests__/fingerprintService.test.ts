import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  net: { request: vi.fn() },
  app: { getPath: vi.fn().mockReturnValue('/tmp/weflow-test') },
}))

vi.mock('../intelligenceDb', () => ({
  intelligenceDb: {
    getRelationship: vi.fn().mockReturnValue(null),
    saveFingerprintSnapshot: vi.fn().mockReturnValue(1),
    getLatestSnapshot: vi.fn().mockReturnValue(null),
    getSnapshotHistory: vi.fn().mockReturnValue([]),
    saveDriftEvent: vi.fn().mockReturnValue(1),
  },
}))

import { FingerprintService, DIMENSION_ORDER, DIMENSION_NAMES_ZH } from '../fingerprintService'

describe('FingerprintService', () => {
  let service: FingerprintService

  beforeEach(() => {
    service = new FingerprintService()
  })

  const makeMessages = (count: number) => {
    const now = Date.now() / 1000
    return Array.from({ length: count }, (_, i) => ({
      sender: i % 3 === 0 ? '张三' : i % 3 === 1 ? '李四' : '王五',
      timestamp: now - i * 3600, // One per hour
      content: `测试消息 ${i} ${'😀'.repeat(i % 3)}`,
      isGroup: false,
      isSend: i % 2 === 0,
    }))
  }

  describe('computeFingerprint', () => {
    it('should return null for insufficient data', () => {
      const result = service.computeFingerprint([])
      expect(result).toBeNull()
    })

    it('should return null for too few messages', () => {
      const result = service.computeFingerprint(makeMessages(2))
      expect(result).toBeNull()
    })

    it('should compute fingerprint with valid data', () => {
      const fp = service.computeFingerprint(makeMessages(20))
      expect(fp).not.toBeNull()
      expect(fp!.dimensions).toBeDefined()
      expect(fp!.dimensions.social_breadth).toBeGreaterThan(0)
    })

    it('should track unique contacts', () => {
      const fp = service.computeFingerprint(makeMessages(20))
      expect(fp!.dimensions.social_breadth).toBe(3) // 张三, 李四, 王五
    })

    it('should include raw metrics', () => {
      const fp = service.computeFingerprint(makeMessages(20))
      expect(fp!.rawMetrics.record_count).toBeGreaterThan(0)
      expect(fp!.rawMetrics.emoji_rate).toBeDefined()
    })
  })

  describe('detectDrift', () => {
    it('should detect increasing dimension', () => {
      const baseline = {
        periodStart: '2024-01-01', periodEnd: '2024-01-07',
        dimensions: { social_breadth: 5, social_depth: 3 },
        rawMetrics: {}, generatedAt: '2024-01-07',
      }
      const current = {
        periodStart: '2024-01-08', periodEnd: '2024-01-14',
        dimensions: { social_breadth: 10, social_depth: 3 },
        rawMetrics: {}, generatedAt: '2024-01-14',
      }
      const drifts = service.detectDrift(current, baseline)
      const breadthDrift = drifts.find(d => d.dimension === 'social_breadth')
      expect(breadthDrift).toBeDefined()
      expect(breadthDrift!.direction).toBe('increasing')
    })

    it('should detect decreasing dimension', () => {
      const baseline = {
        periodStart: '', periodEnd: '',
        dimensions: { social_breadth: 10 },
        rawMetrics: {}, generatedAt: '',
      }
      const current = {
        periodStart: '', periodEnd: '',
        dimensions: { social_breadth: 5 },
        rawMetrics: {}, generatedAt: '',
      }
      const drifts = service.detectDrift(current, baseline)
      const drift = drifts.find(d => d.dimension === 'social_breadth')
      expect(drift?.direction).toBe('decreasing')
    })

    it('should not report drift for stable dimensions', () => {
      const fp = {
        periodStart: '', periodEnd: '',
        dimensions: { social_breadth: 5 },
        rawMetrics: {}, generatedAt: '',
      }
      const drifts = service.detectDrift(fp, fp)
      expect(drifts).toHaveLength(0)
    })
  })

  describe('constants', () => {
    it('should have all dimension names in Chinese', () => {
      for (const dim of DIMENSION_ORDER) {
        expect(DIMENSION_NAMES_ZH[dim]).toBeDefined()
      }
    })
  })
})
