/**
 * Behavioral Fingerprint Service — multi-dimensional behavior pattern tracking.
 *
 * Computes a behavioral fingerprint (7 dimensions) from message data,
 * detects drift between snapshots, and stores time-series for tracking.
 *
 * Ported from One's fingerprint.py to TypeScript.
 *
 * Dimensions:
 *   social_breadth   — unique contacts count
 *   social_depth     — avg conversation turns per contact
 *   family_time      — family message ratio
 *   spending_health  — necessity ratio in purchases
 *   learning_signal  — learning content ratio
 *   active_hours     — activity time regularity (stddev of active hours)
 *   content_creation — creation vs consumption ratio
 */

import { intelligenceDb } from './intelligenceDb'

// ─── Data Models ───────────────────────────────────────────────

export interface BehavioralFingerprint {
  periodStart: string   // ISO datetime
  periodEnd: string     // ISO datetime
  dimensions: Record<string, number>  // raw values (not normalized)
  rawMetrics: Record<string, any>
  generatedAt: string
}

export interface FingerprintDrift {
  dimension: string
  direction: 'increasing' | 'decreasing' | 'stable'
  magnitude: number   // absolute delta as fraction of baseline
  currentValue: number
  baselineValue: number
  description: string
}

export interface DimensionCorrelation {
  dimA: string
  dimB: string
  coefficient: number
  description: string
}

// ─── Constants ─────────────────────────────────────────────────

export const DIMENSION_NAMES_ZH: Record<string, string> = {
  social_breadth: '社交广度',
  social_depth: '社交深度',
  family_time: '家庭时间',
  spending_health: '消费健康',
  learning_signal: '学习信号',
  active_hours: '作息规律',
  content_creation: '内容创作',
}

export const DIMENSION_NAMES_EN: Record<string, string> = {
  social_breadth: 'Social Reach',
  social_depth: 'Social Depth',
  family_time: 'Family Time',
  spending_health: 'Spending Health',
  learning_signal: 'Learning Signal',
  active_hours: 'Daily Rhythm',
  content_creation: 'Content Creation',
}

export const DIMENSION_ORDER = [
  'social_breadth', 'social_depth', 'family_time',
  'spending_health', 'learning_signal', 'active_hours',
  'content_creation',
]

const DRIFT_DIRECTION_ZH: Record<string, string> = {
  increasing: '增加',
  decreasing: '减少',
  stable: '稳定',
}

// Drift detection threshold: 20% change is significant
const DRIFT_THRESHOLD = 0.2

// ─── Normalization Helpers ─────────────────────────────────────

function normalizeMinMax(value: number, allValues: number[]): number {
  if (allValues.length === 0) return 0.5
  const mn = Math.min(...allValues)
  const mx = Math.max(...allValues)
  if (mn === mx) return 0.5
  return Math.max(0, Math.min(1, (value - mn) / (mx - mn)))
}

function sigmoidNormalize(value: number, anchor: number = 4.0): number {
  return 1.0 / (1.0 + Math.exp((value - anchor) / 1.5))
}

// ─── Service ───────────────────────────────────────────────────

export class FingerprintService {

  /**
   * Compute behavioral fingerprint from message data.
   *
   * @param messages - Array of messages with sender, timestamp, content
   * @param periodDays - Number of days to analyze (default 7)
   * @returns BehavioralFingerprint or null if insufficient data
   */
  computeFingerprint(
    messages: Array<{
      sender: string
      timestamp: number
      content: string
      isGroup: boolean
      isSend: boolean
    }>,
    periodDays: number = 7,
  ): BehavioralFingerprint | null {
    if (messages.length < 5) return null

    const now = new Date()
    const cutoff = new Date(now.getTime() - periodDays * 24 * 3600 * 1000)
    const recent = messages.filter(m => new Date(m.timestamp * 1000) >= cutoff)
    if (recent.length < 3) return null

    // Social breadth: unique contacts
    const uniqueContacts = new Set(recent.filter(m => !m.isSend).map(m => m.sender))
    const socialBreadth = uniqueContacts.size

    // Social depth: average turns per contact
    const turnsPerContact = new Map<string, number>()
    for (const m of recent) {
      if (!m.isSend) {
        turnsPerContact.set(m.sender, (turnsPerContact.get(m.sender) || 0) + 1)
      }
    }
    const avgTurns = turnsPerContact.size > 0
      ? Array.from(turnsPerContact.values()).reduce((a, b) => a + b, 0) / turnsPerContact.size
      : 0

    // Family time: ratio of family messages (heuristic: contacts with 'family' relationship)
    let familyCount = 0
    for (const contact of uniqueContacts) {
      const rel = intelligenceDb.getRelationship(contact)
      if (rel?.relationship_type === 'family') {
        familyCount += turnsPerContact.get(contact) || 0
      }
    }
    const familyRatio = recent.length > 0 ? familyCount / recent.length : 0

    // Active hours: compute stddev of hour distribution
    const hourCounts = new Array(24).fill(0)
    for (const m of recent) {
      if (m.isSend) {
        const hour = new Date(m.timestamp * 1000).getHours()
        hourCounts[hour]++
      }
    }
    const activeHours = hourCounts.filter(c => c > 0)
    const avgHour = activeHours.length > 0
      ? activeHours.reduce((a, b) => a + b, 0) / activeHours.length
      : 0
    const hourStddev = activeHours.length > 1
      ? Math.sqrt(activeHours.reduce((sum, h) => sum + Math.pow(h - avgHour, 2), 0) / activeHours.length)
      : 0

    // Content length analysis
    const sentMessages = recent.filter(m => m.isSend)
    const avgContentLen = sentMessages.length > 0
      ? sentMessages.reduce((sum, m) => sum + m.content.length, 0) / sentMessages.length
      : 0

    // Emoji usage frequency
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu
    const emojiCount = sentMessages.reduce((sum, m) => {
      const matches = m.content.match(emojiPattern)
      return sum + (matches ? matches.length : 0)
    }, 0)
    const emojiRate = sentMessages.length > 0 ? emojiCount / sentMessages.length : 0

    const dimensions: Record<string, number> = {
      social_breadth: socialBreadth,
      social_depth: avgTurns,
      family_time: familyRatio,
      spending_health: 0.5, // Placeholder - would need spending data
      learning_signal: 0.0, // Placeholder - would need content analysis
      active_hours: sigmoidNormalize(hourStddev),
      content_creation: 0.0, // Placeholder - would need content analysis
    }

    const rawMetrics: Record<string, any> = {
      record_count: recent.length,
      period_days: periodDays,
      unique_contacts: socialBreadth,
      avg_turns_per_contact: avgTurns,
      family_message_ratio: familyRatio,
      hour_stddev: hourStddev,
      avg_content_length: avgContentLen,
      emoji_rate: emojiRate,
      sent_message_count: sentMessages.length,
    }

    return {
      periodStart: cutoff.toISOString(),
      periodEnd: now.toISOString(),
      dimensions,
      rawMetrics,
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Detect drift between current and baseline fingerprints.
   */
  detectDrift(
    current: BehavioralFingerprint,
    baseline: BehavioralFingerprint,
  ): FingerprintDrift[] {
    const drifts: FingerprintDrift[] = []

    for (const dim of DIMENSION_ORDER) {
      const currentVal = current.dimensions[dim] ?? 0
      const baselineVal = baseline.dimensions[dim] ?? 0

      if (baselineVal === 0 && currentVal === 0) continue

      const denominator = Math.max(Math.abs(baselineVal), 0.01)
      const magnitude = Math.abs(currentVal - baselineVal) / denominator

      if (magnitude >= DRIFT_THRESHOLD) {
        const direction: 'increasing' | 'decreasing' | 'stable' =
          currentVal > baselineVal ? 'increasing' : 'decreasing'

        const dimNameZh = DIMENSION_NAMES_ZH[dim] || dim
        const dirZh = DRIFT_DIRECTION_ZH[direction]
        const description = `${dimNameZh}${dirZh}了 ${(magnitude * 100).toFixed(0)}%`

        drifts.push({
          dimension: dim,
          direction,
          magnitude,
          currentValue: currentVal,
          baselineValue: baselineVal,
          description,
        })
      }
    }

    return drifts.sort((a, b) => b.magnitude - a.magnitude)
  }

  /**
   * Store a fingerprint snapshot for historical tracking.
   */
  storeSnapshot(fingerprint: BehavioralFingerprint): number {
    return intelligenceDb.saveFingerprintSnapshot({
      period_start: fingerprint.periodStart,
      period_end: fingerprint.periodEnd,
      dimensions: JSON.stringify(fingerprint.dimensions),
      raw_metrics: JSON.stringify(fingerprint.rawMetrics),
      generated_at: fingerprint.generatedAt,
    })
  }

  /**
   * Get the latest stored snapshot.
   */
  getLatestSnapshot(): BehavioralFingerprint | null {
    const raw = intelligenceDb.getLatestSnapshot()
    if (!raw) return null
    return {
      periodStart: raw.period_start,
      periodEnd: raw.period_end,
      dimensions: JSON.parse(raw.dimensions || '{}'),
      rawMetrics: JSON.parse(raw.raw_metrics || '{}'),
      generatedAt: raw.generated_at,
    }
  }

  /**
   * Get snapshot history.
   */
  getHistory(limit: number = 10): BehavioralFingerprint[] {
    return intelligenceDb.getSnapshotHistory(limit).map((raw: any) => ({
      periodStart: raw.period_start,
      periodEnd: raw.period_end,
      dimensions: JSON.parse(raw.dimensions || '{}'),
      rawMetrics: JSON.parse(raw.raw_metrics || '{}'),
      generatedAt: raw.generated_at,
    }))
  }

  /**
   * Compute and compare: generate current fingerprint, detect drift,
   * store snapshot, and return the analysis.
   */
  async analyzeAndStore(
    messages: Array<{
      sender: string
      timestamp: number
      content: string
      isGroup: boolean
      isSend: boolean
    }>,
  ): Promise<{
    fingerprint: BehavioralFingerprint | null
    drifts: FingerprintDrift[]
  }> {
    const fingerprint = this.computeFingerprint(messages)
    if (!fingerprint) return { fingerprint: null, drifts: [] }

    const baseline = this.getLatestSnapshot()
    const drifts = baseline ? this.detectDrift(fingerprint, baseline) : []

    this.storeSnapshot(fingerprint)

    // Save drift events
    for (const drift of drifts) {
      intelligenceDb.saveDriftEvent({
        dimension: drift.dimension,
        direction: drift.direction,
        magnitude: drift.magnitude,
        current_value: drift.currentValue,
        baseline_value: drift.baselineValue,
        description: drift.description,
        detected_at: new Date().toISOString(),
      })
    }

    return { fingerprint, drifts }
  }
}

export const fingerprintService = new FingerprintService()
