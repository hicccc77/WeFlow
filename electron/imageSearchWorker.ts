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

type Candidate = { score: number; path: string; isThumb: boolean; hasX: boolean }

const payload = workerData as WorkerPayload

function looksLikeMd5(value: string): boolean {
  return /^[a-fA-F0-9]{16,32}$/.test(value)
}

function hasXVariant(baseLower: string): boolean {
  return /[._][a-z]$/.test(baseLower)
}

function hasImageVariantSuffix(baseLower: string): boolean {
  return /[._][a-z]$/.test(baseLower)
}

function isLikelyImageDatBase(baseLower: string): boolean {
  return hasImageVariantSuffix(baseLower) || looksLikeMd5(baseLower)
}

function normalizeDatBase(name: string): string {
  let base = name.toLowerCase()
  if (base.endsWith('.dat') || base.endsWith('.jpg')) {
    base = base.slice(0, -4)
  }
  while (/[._][a-z]$/.test(base)) {
    base = base.slice(0, -2)
  }
  return base
}

function matchesDatName(fileName: string, datName: string): boolean {
  const lower = fileName.toLowerCase()
  const base = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
  const normalizedBase = normalizeDatBase(base)
  const normalizedTarget = normalizeDatBase(datName.toLowerCase())
  if (normalizedBase === normalizedTarget) return true
  const pattern = new RegExp(`^${datName}(?:[._][a-z])?\\.dat$`)
  if (pattern.test(lower)) return true
  return lower.endsWith('.dat') && lower.includes(datName)
}

function scoreDatName(fileName: string): number {
  if (fileName.includes('.t.dat') || fileName.includes('_t.dat')) return 1
  if (fileName.includes('.c.dat') || fileName.includes('_c.dat')) return 1
  return 2
}

function isThumbnailDat(fileName: string): boolean {
  return fileName.includes('.t.dat') || fileName.includes('_t.dat')
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
      if (!hasXVariant(baseLower)) continue
      if (!matchesDatName(lower, datName)) continue
      matchedBases.add(baseLower)
      const isThumb = isThumbnailDat(lower)
      if (!allowThumbnail && isThumb) continue
      if (thumbOnly && !isThumb) continue
      const score = scoreDatName(lower)
      candidates.push({
        score,
        path: entryPath,
        isThumb,
        hasX: hasXVariant(baseLower)
      })
    }
  }
  if (!candidates.length) {
    return { path: null, matchedBases: Array.from(matchedBases).slice(0, 20) }
  }

  const withX = candidates.filter((item) => item.hasX)
  const basePool = withX.length ? withX : candidates
  const nonThumb = basePool.filter((item) => !item.isThumb)
  const finalPool = thumbOnly ? basePool : (nonThumb.length ? nonThumb : basePool)

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
