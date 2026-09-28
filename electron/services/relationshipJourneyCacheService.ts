import { dirname, join } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { rename, rm, writeFile } from 'fs/promises'
import { app } from 'electron'
import { ConfigService } from './config'

/**
 * Bump whenever the persisted shape or the privacy allow-list changes. Older
 * files are cache only, so incompatible versions are removed instead of
 * migrated and accidentally retaining fields that are no longer allowed.
 */
const CACHE_VERSION = 1
const CACHE_FILE_NAME = 'relationship-journey.json'
const MAX_ACCOUNT_SCOPES = 12
const MAX_FULL_ANALYSES_PER_ACCOUNT = 2_000
const MAX_ADJUDICATIONS_PER_ACCOUNT = 2_000
const MAX_RESULT_BYTES = 512 * 1024
const MAX_STRING_LENGTH = 8_192
const MAX_REASON_CODES = 32
const MAX_REASON_CODE_LENGTH = 96
const CACHE_REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800]

function isRetryableCacheReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST'
}

function waitForCacheReplaceRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

const FORBIDDEN_RESULT_KEYS = new Set([
  'prompt',
  'systemprompt',
  'userprompt',
  'rawoutput',
  'rawcontent',
  'parsedcontent',
  'content',
  'messages',
  'messagekey',
  'localid',
  'serverid',
  'dbpath',
  'dbpathhint',
  'filepath',
  'originaltext',
  'sourcetext',
  'excerpt',
  'displayname',
  'avatarurl',
  'sender',
  'sendername',
  'senderusername'
])

export type RelationshipJourneyAdjudicationVerdict =
  | 'peer_conflict'
  | 'shared_external_hostility'
  | 'third_party_discussion'
  | 'playful_banter'
  | 'unclear'

export type RelationshipJourneyAdjudicationTarget =
  | 'each_other'
  | 'external'
  | 'mixed'
  | 'unknown'

const ADJUDICATION_VERDICTS = new Set<RelationshipJourneyAdjudicationVerdict>([
  'peer_conflict',
  'shared_external_hostility',
  'third_party_discussion',
  'playful_banter',
  'unclear'
])

const ADJUDICATION_TARGETS = new Set<RelationshipJourneyAdjudicationTarget>([
  'each_other',
  'external',
  'mixed',
  'unknown'
])

export interface RelationshipJourneyFullAnalysisEntry<TResult = unknown> {
  fingerprint: string
  algorithmVersion: string
  modelFingerprint: string
  /** A cache-safe analysis result. Message text and provider request data are rejected at runtime. */
  result: TResult
  updatedAt: number
}

export interface RelationshipJourneyAdjudicationDecision {
  candidateHash: string
  classifierVersion: string
  modelFingerprint: string
  verdict: RelationshipJourneyAdjudicationVerdict
  target: RelationshipJourneyAdjudicationTarget
  mutual: boolean
  contextSufficient: boolean
  /** Classifier confidence on a 0..1 scale. */
  confidence: number
  /** Stable machine-readable codes only; explanatory text belongs in the UI layer. */
  reasonCodes: string[]
  updatedAt: number
}

export interface RelationshipJourneyFullAnalysisMatch {
  fingerprint?: string
  algorithmVersion?: string
  modelFingerprint?: string
}

export interface RelationshipJourneyAdjudicationMatch {
  classifierVersion?: string
  modelFingerprint?: string
}

interface RelationshipJourneyAccountCache {
  fullAnalyses: Record<string, RelationshipJourneyFullAnalysisEntry>
  adjudications: Record<string, RelationshipJourneyAdjudicationDecision>
}

interface RelationshipJourneyCacheStore {
  version: number
  accounts: Record<string, RelationshipJourneyAccountCache>
}

const emptyStore = (): RelationshipJourneyCacheStore => ({
  version: CACHE_VERSION,
  accounts: {}
})

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const normalizeKey = (value: unknown, maxLength = 512): string => {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || normalized.includes('\u0000')) return ''
  if (normalized === '__proto__' || normalized === 'prototype' || normalized === 'constructor') return ''
  return normalized
}

const normalizeVersion = (value: unknown): string => normalizeKey(value, 160)

const normalizeMachineCode = (value: unknown, maxLength: number): string => {
  const normalized = normalizeKey(value, maxLength)
  return normalized && /^[a-z0-9][a-z0-9._:-]*$/i.test(normalized) ? normalized : ''
}

const normalizeUpdatedAt = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.floor(numeric)
}

const normalizedFieldName = (key: string): string => key.toLowerCase().replace(/[-_\s]+/g, '')

/**
 * Produce a JSON-only deep clone while enforcing the cache privacy boundary.
 * Repeated references are copied independently; cycles, class instances and
 * forbidden provider/message fields fail closed rather than being serialized.
 */
const cloneCacheSafeValue = (value: unknown, ancestors = new WeakSet<object>(), depth = 0): unknown => {
  if (depth > 40) throw new TypeError('Relationship journey cache result is too deeply nested')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Relationship journey cache result contains a non-finite number')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new TypeError('Relationship journey cache result contains an oversized string')
    }
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError('Relationship journey cache result must be JSON serializable')
  }

  const objectValue = value as object
  if (ancestors.has(objectValue)) throw new TypeError('Relationship journey cache result contains a cycle')
  ancestors.add(objectValue)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => cloneCacheSafeValue(item, ancestors, depth + 1))
    }
    if (!isPlainObject(value)) {
      throw new TypeError('Relationship journey cache result contains a non-plain object')
    }

    const cloned: Record<string, unknown> = Object.create(null)
    for (const [key, child] of Object.entries(value)) {
      const safeKey = normalizeKey(key, 160)
      if (!safeKey) throw new TypeError('Relationship journey cache result contains an invalid key')
      if (FORBIDDEN_RESULT_KEYS.has(normalizedFieldName(safeKey))) {
        throw new TypeError(`Relationship journey cache refuses sensitive field: ${safeKey}`)
      }
      if (child === undefined) continue
      cloned[safeKey] = cloneCacheSafeValue(child, ancestors, depth + 1)
    }
    return cloned
  } finally {
    ancestors.delete(objectValue)
  }
}

const cloneAndMeasureResult = <TResult>(value: TResult): TResult => {
  const cloned = cloneCacheSafeValue(value)
  const serialized = JSON.stringify(cloned)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
    throw new TypeError('Relationship journey cache result exceeds the size limit')
  }
  // A JSON round-trip strips the null prototypes created above and guarantees
  // callers never receive references owned by the in-memory cache.
  return JSON.parse(serialized) as TResult
}

const normalizeFullAnalysis = <TResult>(
  raw: unknown
): RelationshipJourneyFullAnalysisEntry<TResult> | null => {
  if (!isPlainObject(raw)) return null
  const fingerprint = normalizeKey(raw.fingerprint)
  const algorithmVersion = normalizeVersion(raw.algorithmVersion)
  const modelFingerprint = normalizeKey(raw.modelFingerprint, 256)
  const updatedAt = normalizeUpdatedAt(raw.updatedAt)
  if (!fingerprint || !algorithmVersion || !modelFingerprint || !updatedAt || !('result' in raw)) return null

  try {
    return {
      fingerprint,
      algorithmVersion,
      modelFingerprint,
      result: cloneAndMeasureResult(raw.result) as TResult,
      updatedAt
    }
  } catch {
    return null
  }
}

const normalizeReasonCodes = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null
  const codes: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const code = normalizeMachineCode(item, MAX_REASON_CODE_LENGTH)
    if (!code || seen.has(code)) continue
    seen.add(code)
    codes.push(code)
    if (codes.length >= MAX_REASON_CODES) break
  }
  return codes
}

const normalizeAdjudication = (raw: unknown): RelationshipJourneyAdjudicationDecision | null => {
  if (!isPlainObject(raw)) return null
  const candidateHash = normalizeKey(raw.candidateHash)
  const classifierVersion = normalizeVersion(raw.classifierVersion)
  const modelFingerprint = normalizeKey(raw.modelFingerprint, 256)
  const verdict = normalizeMachineCode(raw.verdict, 64)
  const target = normalizeMachineCode(raw.target, 64)
  const updatedAt = normalizeUpdatedAt(raw.updatedAt)
  const confidence = Number(raw.confidence)
  const reasonCodes = normalizeReasonCodes(raw.reasonCodes)
  if (
    !candidateHash ||
    !classifierVersion ||
    !modelFingerprint ||
    !verdict ||
    !target ||
    !ADJUDICATION_VERDICTS.has(verdict as RelationshipJourneyAdjudicationVerdict) ||
    !ADJUDICATION_TARGETS.has(target as RelationshipJourneyAdjudicationTarget) ||
    !updatedAt ||
    typeof raw.mutual !== 'boolean' ||
    typeof raw.contextSufficient !== 'boolean' ||
    !Number.isFinite(confidence) ||
    !reasonCodes
  ) {
    return null
  }

  return {
    candidateHash,
    classifierVersion,
    modelFingerprint,
    verdict: verdict as RelationshipJourneyAdjudicationVerdict,
    target: target as RelationshipJourneyAdjudicationTarget,
    mutual: raw.mutual,
    contextSufficient: raw.contextSufficient,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasonCodes: [...reasonCodes],
    updatedAt
  }
}

const cloneFullAnalysis = <TResult>(
  entry: RelationshipJourneyFullAnalysisEntry<TResult>
): RelationshipJourneyFullAnalysisEntry<TResult> => ({
  fingerprint: entry.fingerprint,
  algorithmVersion: entry.algorithmVersion,
  modelFingerprint: entry.modelFingerprint,
  result: cloneAndMeasureResult(entry.result),
  updatedAt: entry.updatedAt
})

const cloneAdjudication = (
  decision: RelationshipJourneyAdjudicationDecision
): RelationshipJourneyAdjudicationDecision => ({
  candidateHash: decision.candidateHash,
  classifierVersion: decision.classifierVersion,
  modelFingerprint: decision.modelFingerprint,
  verdict: decision.verdict,
  target: decision.target,
  mutual: decision.mutual,
  contextSufficient: decision.contextSufficient,
  confidence: decision.confidence,
  reasonCodes: [...decision.reasonCodes],
  updatedAt: decision.updatedAt
})

const latestAccountUpdate = (account: RelationshipJourneyAccountCache): number => Math.max(
  0,
  ...Object.values(account.fullAnalyses).map((entry) => entry.updatedAt),
  ...Object.values(account.adjudications).map((entry) => entry.updatedAt)
)

export class RelationshipJourneyCacheService {
  private readonly cacheFilePath: string
  private persistTimer: NodeJS.Timeout | null = null
  private persistInFlight = false
  private persistDirty = false
  private persistGeneration = 0
  private store: RelationshipJourneyCacheStore = emptyStore()

  constructor(cacheBasePath?: string) {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheFilePath = join(basePath, CACHE_FILE_NAME)
    this.ensureCacheDir()
    this.load()
    app?.once('will-quit', () => this.flushSync())
  }

  getFullAnalysis<TResult = unknown>(
    accountScope: string,
    sessionId: string,
    match: RelationshipJourneyFullAnalysisMatch = {}
  ): RelationshipJourneyFullAnalysisEntry<TResult> | undefined {
    const scopeKey = normalizeKey(accountScope)
    const normalizedSessionId = normalizeKey(sessionId)
    if (!scopeKey || !normalizedSessionId) return undefined

    const raw = this.store.accounts[scopeKey]?.fullAnalyses[normalizedSessionId]
    const entry = normalizeFullAnalysis<TResult>(raw)
    if (!entry) {
      if (raw) this.deleteFullAnalysis(scopeKey, normalizedSessionId)
      return undefined
    }
    if (match.fingerprint !== undefined && entry.fingerprint !== match.fingerprint) return undefined
    if (match.algorithmVersion !== undefined && entry.algorithmVersion !== match.algorithmVersion) return undefined
    if (match.modelFingerprint !== undefined && entry.modelFingerprint !== match.modelFingerprint) return undefined
    return cloneFullAnalysis(entry)
  }

  setFullAnalysis<TResult>(
    accountScope: string,
    sessionId: string,
    entry: RelationshipJourneyFullAnalysisEntry<TResult>
  ): void {
    const scopeKey = normalizeKey(accountScope)
    const normalizedSessionId = normalizeKey(sessionId)
    if (!scopeKey || !normalizedSessionId) throw new TypeError('Relationship journey cache scope/session is invalid')
    const normalized = normalizeFullAnalysis<TResult>(entry)
    if (!normalized) throw new TypeError('Relationship journey full analysis is invalid or contains sensitive fields')

    const account = this.ensureAccount(scopeKey)
    account.fullAnalyses[normalizedSessionId] = cloneFullAnalysis(normalized)
    this.trimAccount(scopeKey)
    this.trimAccounts()
    this.persist()
  }

  /**
   * Invalidate only the source fingerprint while retaining the content-free
   * incremental checkpoint. The next read resumes from its watermark instead
   * of scanning the whole conversation again.
   */
  markFullAnalysisStale(accountScope: string, sessionId: string): void {
    const scopeKey = normalizeKey(accountScope)
    const normalizedSessionId = normalizeKey(sessionId)
    if (!scopeKey || !normalizedSessionId) return
    const raw = this.store.accounts[scopeKey]?.fullAnalyses[normalizedSessionId]
    const entry = normalizeFullAnalysis(raw)
    if (!entry) return
    entry.fingerprint = `stale:${Date.now().toString(36)}`
    this.store.accounts[scopeKey].fullAnalyses[normalizedSessionId] = entry
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
  }

  /** Preserve every session checkpoint for an account while expiring exact hits. */
  markFullAnalysesStale(accountScope: string): void {
    const scopeKey = normalizeKey(accountScope)
    const account = this.store.accounts[scopeKey]
    if (!scopeKey || !account) return
    const stalePrefix = `stale:${Date.now().toString(36)}`
    for (const [sessionId, raw] of Object.entries(account.fullAnalyses)) {
      const entry = normalizeFullAnalysis(raw)
      if (!entry) {
        delete account.fullAnalyses[sessionId]
        continue
      }
      entry.fingerprint = `${stalePrefix}:${sessionId.slice(0, 24)}`
      account.fullAnalyses[sessionId] = entry
    }
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
  }

  /** Remove a page-level result without discarding content-hash adjudications. */
  deleteFullAnalysis(accountScope: string, sessionId: string): void {
    const scopeKey = normalizeKey(accountScope)
    const normalizedSessionId = normalizeKey(sessionId)
    if (!scopeKey || !normalizedSessionId) return

    this.persistGeneration += 1
    const account = this.store.accounts[scopeKey]
    if (account) {
      delete account.fullAnalyses[normalizedSessionId]
      if (Object.keys(account.fullAnalyses).length === 0 && Object.keys(account.adjudications).length === 0) {
        delete this.store.accounts[scopeKey]
      }
    }
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
  }

  /** Clear every page-level result for an account while retaining adjudications. */
  clearFullAnalyses(accountScope: string): void {
    const scopeKey = normalizeKey(accountScope)
    if (!scopeKey) return

    this.persistGeneration += 1
    const account = this.store.accounts[scopeKey]
    if (account) {
      account.fullAnalyses = Object.create(null)
      if (Object.keys(account.adjudications).length === 0) {
        delete this.store.accounts[scopeKey]
      }
    }
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
  }

  getAdjudication(
    accountScope: string,
    candidateHash: string,
    match: RelationshipJourneyAdjudicationMatch = {}
  ): RelationshipJourneyAdjudicationDecision | undefined {
    const scopeKey = normalizeKey(accountScope)
    const normalizedCandidateHash = normalizeKey(candidateHash)
    if (!scopeKey || !normalizedCandidateHash) return undefined

    const raw = this.store.accounts[scopeKey]?.adjudications[normalizedCandidateHash]
    const decision = normalizeAdjudication(raw)
    if (!decision) {
      if (raw) this.deleteAdjudication(scopeKey, normalizedCandidateHash)
      return undefined
    }
    if (match.classifierVersion !== undefined && decision.classifierVersion !== match.classifierVersion) return undefined
    if (match.modelFingerprint !== undefined && decision.modelFingerprint !== match.modelFingerprint) return undefined
    return cloneAdjudication(decision)
  }

  setAdjudication(accountScope: string, decision: RelationshipJourneyAdjudicationDecision): void {
    const scopeKey = normalizeKey(accountScope)
    if (!scopeKey) throw new TypeError('Relationship journey cache account scope is invalid')
    const normalized = normalizeAdjudication(decision)
    if (!normalized) throw new TypeError('Relationship journey adjudication is invalid')

    const account = this.ensureAccount(scopeKey)
    account.adjudications[normalized.candidateHash] = cloneAdjudication(normalized)
    this.trimAccount(scopeKey)
    this.trimAccounts()
    this.persist()
  }

  clearAccount(accountScope: string): void {
    const scopeKey = normalizeKey(accountScope)
    if (!scopeKey) return
    this.persistGeneration += 1
    delete this.store.accounts[scopeKey]
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
  }

  clearAll(): void {
    this.persistGeneration += 1
    this.store = emptyStore()
    this.persistDirty = false
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      rmSync(this.cacheFilePath, { force: true })
    } catch (error) {
      console.error('RelationshipJourneyCacheService: failed to clear cache', error)
    }
  }

  /**
   * Persist the current generation synchronously. Incrementing the generation
   * first prevents an older async snapshot from overwriting this one later.
   */
  flushSync(): void {
    this.persistGeneration += 1
    this.persistDirty = false
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistCurrentStoreSync()
  }

  /** Restore the latest in-memory generation after a stale async rename wins a race. */
  private persistCurrentStoreSync(): void {
    if (Object.keys(this.store.accounts).length === 0) {
      try { rmSync(this.cacheFilePath, { force: true }) } catch {}
      return
    }
    this.ensureCacheDir()
    const temporaryPath = `${this.cacheFilePath}.${process.pid}.${this.persistGeneration}.sync.tmp`
    try {
      writeFileSync(temporaryPath, JSON.stringify(this.store), 'utf8')
      renameSync(temporaryPath, this.cacheFilePath)
    } catch (error) {
      try { rmSync(temporaryPath, { force: true }) } catch {}
      console.error('RelationshipJourneyCacheService: failed to flush cache', error)
    }
  }

  private ensureCacheDir(): void {
    const directory = dirname(this.cacheFilePath)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  }

  private ensureAccount(accountScope: string): RelationshipJourneyAccountCache {
    const current = this.store.accounts[accountScope]
    if (current) return current
    const created: RelationshipJourneyAccountCache = {
      fullAnalyses: Object.create(null),
      adjudications: Object.create(null)
    }
    this.store.accounts[accountScope] = created
    return created
  }

  private deleteAdjudication(accountScope: string, candidateHash: string): void {
    this.persistGeneration += 1
    const account = this.store.accounts[accountScope]
    if (account) {
      delete account.adjudications[candidateHash]
      if (Object.keys(account.fullAnalyses).length === 0 && Object.keys(account.adjudications).length === 0) {
        delete this.store.accounts[accountScope]
      }
    }
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
  }

  private load(): void {
    if (!existsSync(this.cacheFilePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFilePath, 'utf8')) as unknown
      if (!isPlainObject(parsed) || Number(parsed.version) !== CACHE_VERSION || !isPlainObject(parsed.accounts)) {
        this.discardIncompatibleFile()
        return
      }

      const accounts: Record<string, RelationshipJourneyAccountCache> = Object.create(null)
      for (const [rawScopeKey, rawAccount] of Object.entries(parsed.accounts)) {
        const scopeKey = normalizeKey(rawScopeKey)
        if (!scopeKey || !isPlainObject(rawAccount)) continue
        const fullAnalysesRaw = isPlainObject(rawAccount.fullAnalyses) ? rawAccount.fullAnalyses : {}
        const adjudicationsRaw = isPlainObject(rawAccount.adjudications) ? rawAccount.adjudications : {}
        const fullAnalyses: Record<string, RelationshipJourneyFullAnalysisEntry> = Object.create(null)
        const adjudications: Record<string, RelationshipJourneyAdjudicationDecision> = Object.create(null)

        for (const [rawSessionId, rawEntry] of Object.entries(fullAnalysesRaw)) {
          const sessionId = normalizeKey(rawSessionId)
          const entry = normalizeFullAnalysis(rawEntry)
          if (sessionId && entry) fullAnalyses[sessionId] = entry
        }
        for (const [rawCandidateHash, rawDecision] of Object.entries(adjudicationsRaw)) {
          const candidateHash = normalizeKey(rawCandidateHash)
          const decision = normalizeAdjudication(rawDecision)
          if (candidateHash && decision && decision.candidateHash === candidateHash) {
            adjudications[candidateHash] = decision
          }
        }
        if (Object.keys(fullAnalyses).length > 0 || Object.keys(adjudications).length > 0) {
          accounts[scopeKey] = { fullAnalyses, adjudications }
        }
      }

      this.store = { version: CACHE_VERSION, accounts }
      for (const scopeKey of Object.keys(this.store.accounts)) this.trimAccount(scopeKey)
      this.trimAccounts()
    } catch (error) {
      console.error('RelationshipJourneyCacheService: failed to load cache', error)
      this.discardIncompatibleFile()
    }
  }

  private discardIncompatibleFile(): void {
    this.store = emptyStore()
    try { rmSync(this.cacheFilePath, { force: true }) } catch {}
  }

  private trimAccount(accountScope: string): void {
    const account = this.store.accounts[accountScope]
    if (!account) return

    const fullEntries = Object.entries(account.fullAnalyses)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_FULL_ANALYSES_PER_ACCOUNT)
    account.fullAnalyses = Object.fromEntries(fullEntries)

    const adjudicationEntries = Object.entries(account.adjudications)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_ADJUDICATIONS_PER_ACCOUNT)
    account.adjudications = Object.fromEntries(adjudicationEntries)
  }

  private trimAccounts(): void {
    const entries = Object.entries(this.store.accounts)
    if (entries.length <= MAX_ACCOUNT_SCOPES) return
    entries.sort((left, right) => latestAccountUpdate(right[1]) - latestAccountUpdate(left[1]))
    this.store.accounts = Object.fromEntries(entries.slice(0, MAX_ACCOUNT_SCOPES))
  }

  private persist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, 1_000)
    this.persistTimer.unref?.()
  }

  private async replaceCacheFileWithRetry(temporaryPath: string, generation: number): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      if (generation !== this.persistGeneration) return false
      try {
        await rename(temporaryPath, this.cacheFilePath)
        return true
      } catch (error) {
        const retryDelay = CACHE_REPLACE_RETRY_DELAYS_MS[attempt]
        if (!isRetryableCacheReplaceError(error) || retryDelay === undefined) throw error
        await waitForCacheReplaceRetry(retryDelay)
      }
    }
  }

  private async persistNow(): Promise<void> {
    if (this.persistInFlight) {
      this.persistDirty = true
      return
    }
    this.persistInFlight = true
    const generation = this.persistGeneration
    const temporaryPath = `${this.cacheFilePath}.${process.pid}.${generation}.tmp`
    const payload = JSON.stringify(this.store)
    try {
      await writeFile(temporaryPath, payload, 'utf8')
      if (generation !== this.persistGeneration) {
        await rm(temporaryPath, { force: true })
        return
      }
      const replaced = await this.replaceCacheFileWithRetry(temporaryPath, generation)
      if (!replaced) {
        await rm(temporaryPath, { force: true })
        return
      }
      if (generation !== this.persistGeneration) {
        // A clear/set/flush happened after this snapshot passed the pre-rename
        // generation check. Re-materialize current memory instead of deleting
        // the destination, which may already have been replaced by flushSync.
        this.persistCurrentStoreSync()
      }
    } catch (error) {
      console.error('RelationshipJourneyCacheService: failed to persist cache', error)
      await rm(temporaryPath, { force: true }).catch(() => {})
    } finally {
      this.persistInFlight = false
      if (this.persistDirty) {
        this.persistDirty = false
        void this.persistNow()
      }
    }
  }
}
