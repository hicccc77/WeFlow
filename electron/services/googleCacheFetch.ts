import { createHash } from 'crypto'

type FetchLike = typeof globalThis.fetch

const GOOGLE_CACHE_TTL_SECONDS = 3600
const EXPIRY_SAFETY_MS = 60_000
const UNSUPPORTED_RETRY_MS = 600_000

type CacheEntry =
  | { kind: 'ready'; name: string; expiresAt: number }
  | { kind: 'unsupported'; retryAt: number }

const cacheRegistry = new Map<string, CacheEntry>()

function hashKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) || undefined
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1]
  const record = headers as Record<string, string>
  const key = Object.keys(record).find((item) => item.toLowerCase() === name)
  return key ? record[key] : undefined
}

async function resolveCacheEntry(
  fetchImplementation: FetchLike,
  apiBase: string,
  key: string,
  prefix: Record<string, unknown>,
  apiKey: string | undefined,
): Promise<CacheEntry> {
  const existing = cacheRegistry.get(key)
  if (existing?.kind === 'ready' && existing.expiresAt > Date.now()) return existing
  if (existing?.kind === 'unsupported' && existing.retryAt > Date.now()) return existing

  let entry: CacheEntry = { kind: 'unsupported', retryAt: Date.now() + UNSUPPORTED_RETRY_MS }
  try {
    const response = await fetchImplementation(`${apiBase}/cachedContents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
      },
      body: JSON.stringify({
        ...prefix,
        ttl: `${GOOGLE_CACHE_TTL_SECONDS}s`,
        displayName: 'weflow-agent-prefix',
      }),
    })
    if (response.ok) {
      const payload = await response.json().catch(() => null) as { name?: unknown } | null
      if (payload?.name) {
        entry = {
          kind: 'ready',
          name: String(payload.name),
          expiresAt: Date.now() + GOOGLE_CACHE_TTL_SECONDS * 1000 - EXPIRY_SAFETY_MS,
        }
      }
    } else {
      await response.text().catch(() => '')
    }
  } catch {
    // A cache creation failure must not block the model request.
  }
  cacheRegistry.set(key, entry)
  return entry
}

export function withGoogleExplicitCache(baseFetch: FetchLike = globalThis.fetch): FetchLike {
  return (async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const match = url.match(/^(.+)\/models\/([^/:?]+):(?:stream)?[gG]enerateContent/)
      if (String(init?.method || 'GET').toUpperCase() !== 'POST' || !match || typeof init?.body !== 'string') {
        return baseFetch(input, init)
      }

      const body = JSON.parse(init.body) as Record<string, unknown>
      if (body.cachedContent || (!body.systemInstruction && !body.tools)) return baseFetch(input, init)

      const prefix = {
        model: `models/${match[2]}`,
        ...(body.systemInstruction !== undefined ? { systemInstruction: body.systemInstruction } : {}),
        ...(body.tools !== undefined ? { tools: body.tools } : {}),
        ...(body.toolConfig !== undefined ? { toolConfig: body.toolConfig } : {}),
      }
      const entry = await resolveCacheEntry(
        baseFetch,
        match[1],
        hashKey(prefix),
        prefix,
        headerValue(init, 'x-goog-api-key'),
      )
      if (entry.kind !== 'ready') return baseFetch(input, init)

      const { systemInstruction: _system, tools: _tools, toolConfig: _toolConfig, ...rest } = body
      return baseFetch(input, { ...init, body: JSON.stringify({ ...rest, cachedContent: entry.name }) })
    } catch {
      return baseFetch(input, init)
    }
  }) as FetchLike
}
