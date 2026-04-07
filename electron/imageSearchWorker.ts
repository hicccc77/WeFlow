import { parentPort, workerData } from 'worker_threads'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'

type WorkerPayload = {
  root: string
  datName: string
  maxDepth: number
  allowThumbnail: boolean
  thumbOnly: boolean
}

type Candidate = { score: number; path: string; isThumb: boolean }

const payload = workerData as WorkerPayload

function looksLikeMd5(value: string): boolean {
  return /^[a-fA-F0-9]{16,32}$/.test(value)
}

function stripDatVariantSuffix(base: string): string {
  const lower = base.toLowerCase()
  const suffixes = ['_thumb', '.thumb', '_hd', '.hd', '_h', '.h', '_b', '.b', '_w', '.w', '_t', '.t', '_c', '.c']
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length)
    }
  }
  if (/[._][a-z]$/.test(lower)) {
    return lower.slice(0, -2)
  }
  return lower
}

function hasXVariant(baseLower: string): boolean {
  return stripDatVariantSuffix(baseLower) !== baseLower
}

function hasImageVariantSuffix(baseLower: string): boolean {
  return stripDatVariantSuffix(baseLower) !== baseLower
}

function normalizeDatBase(name: string): string {
  let base = name.toLowerCase()
  if (base.endsWith('.dat') || base.endsWith('.jpg')) {
    base = base.slice(0, -4)
  }
  while (true) {
    const stripped = stripDatVariantSuffix(base)
    if (stripped === base) {
      return base
    }
    base = stripped
  }
}

function isLikelyImageDatBase(baseLower: string): boolean {
  return hasImageVariantSuffix(baseLower) || looksLikeMd5(normalizeDatBase(baseLower))
}

function matchesDatName(fileName: string, datName: string): boolean {
  const lower = fileName.toLowerCase()
  const base = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
  const normalizedBase = normalizeDatBase(base)
  const normalizedTarget = normalizeDatBase(datName.toLowerCase())
  if (normalizedBase === normalizedTarget) return true
  return lower.endsWith('.dat') && lower.includes(normalizedTarget)
}

function scoreDatName(fileName: string): number {
  const lower = fileName.toLowerCase()
  const baseLower = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
  if (baseLower.endsWith('_h') || baseLower.endsWith('.h')) return 600
  if (baseLower.endsWith('_hd') || baseLower.endsWith('.hd')) return 550
  if (baseLower.endsWith('_b') || baseLower.endsWith('.b')) return 520
  if (baseLower.endsWith('_w') || baseLower.endsWith('.w')) return 510
  if (!hasXVariant(baseLower)) return 500
  if (baseLower.endsWith('_c') || baseLower.endsWith('.c')) return 400
  if (isThumbnailDat(lower)) return 100
  return 350
}

function isThumbnailDat(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return lower.includes('.t.dat') || lower.includes('_t.dat') || lower.includes('_thumb.dat')
}

function walkForDat(
  root: string,
  datName: string,
  maxDepth = 4,
  allowThumbnail = true,
  thumbOnly = false
): { path: string | null; matchedBases: string[] } {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const candidates: Candidate[] = []
  const matchedBases = new Set<string>()

  while (stack.length) {
    const current = stack.pop() as { dir: string; depth: number }
    let entries: string[]
    try {
      entries = readdirSync(current.dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = join(current.dir, entry)
      let stat
      try {
        stat = statSync(entryPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (current.depth < maxDepth) {
          stack.push({ dir: entryPath, depth: current.depth + 1 })
        }
        continue
      }
      const lower = entry.toLowerCase()
      if (!lower.endsWith('.dat')) continue
      const baseLower = lower.slice(0, -4)
      if (!isLikelyImageDatBase(baseLower)) continue
      if (!matchesDatName(lower, datName)) continue
      matchedBases.add(baseLower)
      const isThumb = isThumbnailDat(lower)
      if (!allowThumbnail && isThumb) continue
      if (thumbOnly && !isThumb) continue
      candidates.push({
        score: scoreDatName(lower),
        path: entryPath,
        isThumb
      })
    }
  }
  if (!candidates.length) {
    return { path: null, matchedBases: Array.from(matchedBases).slice(0, 20) }
  }

  const nonThumb = candidates.filter((item) => !item.isThumb)
  const finalPool = thumbOnly ? candidates : (nonThumb.length ? nonThumb : candidates)

  let best: { score: number; path: string } | null = null
  for (const item of finalPool) {
    if (!best || item.score > best.score) {
      best = { score: item.score, path: item.path }
    }
  }
  return { path: best?.path ?? null, matchedBases: Array.from(matchedBases).slice(0, 20) }
}

function run() {
  const result = walkForDat(
    payload.root,
    payload.datName,
    payload.maxDepth,
    payload.allowThumbnail,
    payload.thumbOnly
  )
  parentPort?.postMessage({
    type: 'done',
    path: result.path,
    root: payload.root,
    datName: payload.datName,
    matchedBases: result.matchedBases
  })
}

try {
  run()
} catch (err) {
  parentPort?.postMessage({ type: 'error', error: String(err) })
}
