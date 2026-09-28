import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { ConfigService } from './config'

const CACHE_VERSION = 1
const CACHE_DIRECTORY = 'agent-raw-pages'
const LOCAL_SECRET_PREFIX = 'local:v1:'
const CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024
const CACHE_MAX_FILES = 256
const CACHE_MAX_TOTAL_BYTES = 256 * 1024 * 1024

type AgentRawCacheEnvelope<T> = {
  version: 1
  fingerprint: string
  createdAt: number
  value: T
}

function cachePath(root: string, fingerprint: string): string {
  return join(root, CACHE_DIRECTORY, `${fingerprint}.enc`)
}

function localCacheKey(secret: string): Buffer | null {
  const normalized = String(secret || '')
  return normalized ? createHash('sha256').update('weflow-agent-raw-page\0').update(normalized).digest() : null
}

function protectWithLocalSecret(plaintext: string, secret: string): string | null {
  const key = localCacheKey(secret)
  if (!key || !plaintext) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return LOCAL_SECRET_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

function unprotectWithLocalSecret(stored: string, secret: string): string | null {
  const key = localCacheKey(secret)
  if (!key || !stored.startsWith(LOCAL_SECRET_PREFIX)) return null
  try {
    const payload = Buffer.from(stored.slice(LOCAL_SECRET_PREFIX.length), 'base64')
    if (payload.length <= 28) return null
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
    decipher.setAuthTag(payload.subarray(12, 28))
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

async function pruneCache(directory: string, preservedPath: string): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = (await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.enc'))
      .map(async (entry) => {
        const path = join(directory, entry.name)
        try {
          const metadata = await stat(path)
          return { path, bytes: metadata.size, modifiedAt: metadata.mtimeMs }
        } catch {
          return null
        }
      })))
      .filter((entry): entry is { path: string; bytes: number; modifiedAt: number } => Boolean(entry))
      .sort((left, right) => left.modifiedAt - right.modifiedAt)
    let totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    let totalFiles = files.length
    for (const file of files) {
      if (totalFiles <= CACHE_MAX_FILES && totalBytes <= CACHE_MAX_TOTAL_BYTES) break
      if (file.path === preservedPath) continue
      await rm(file.path, { force: true }).catch(() => undefined)
      totalFiles -= 1
      totalBytes = Math.max(0, totalBytes - file.bytes)
    }
  } catch {
    // 缓存保留采用尽力而为策略。
  }
}

export async function readAgentRawPageCache<T>(
  root: string,
  fingerprint: string,
  localEncryptionSecret = '',
): Promise<T | null> {
  if (!root || !fingerprint) return null
  const path = cachePath(root, fingerprint)
  try {
    const stored = await readFile(path, 'utf8')
    if (Buffer.byteLength(stored, 'utf8') > CACHE_MAX_ENTRY_BYTES * 2) return null
    const plaintext = ConfigService.getInstance().unprotectLocalCachePayload(stored)
      || unprotectWithLocalSecret(stored, localEncryptionSecret)
    if (!plaintext) return null
    const parsed = JSON.parse(plaintext) as AgentRawCacheEnvelope<T>
    if (parsed.version !== CACHE_VERSION || parsed.fingerprint !== fingerprint || parsed.value === undefined) return null
    const now = new Date()
    await utimes(path, now, now).catch(() => undefined)
    return parsed.value
  } catch {
    return null
  }
}

export async function writeAgentRawPageCache<T>(
  root: string,
  fingerprint: string,
  value: T,
  localEncryptionSecret = '',
): Promise<boolean> {
  if (!root || !fingerprint || value === undefined) return false
  const directory = join(root, CACHE_DIRECTORY)
  const target = cachePath(root, fingerprint)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    const plaintext = JSON.stringify({
      version: CACHE_VERSION,
      fingerprint,
      createdAt: Date.now(),
      value,
    } satisfies AgentRawCacheEnvelope<T>)
    if (Buffer.byteLength(plaintext, 'utf8') > CACHE_MAX_ENTRY_BYTES) return false
    const protectedValue = ConfigService.getInstance().protectLocalCachePayload(plaintext)
      || protectWithLocalSecret(plaintext, localEncryptionSecret)
    if (!protectedValue) return false
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, protectedValue, 'utf8')
    await rm(target, { force: true })
    await rename(temporary, target)
    await pruneCache(directory, target)
    return true
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined)
    return false
  }
}
