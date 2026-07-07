import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'

type NativeDecryptResult = {
  data: Buffer
  ext: string
  isWxgf?: boolean
  is_wxgf?: boolean
  version?: number
  aesSize?: number
  aes_size?: number
  xorSize?: number
  xor_size?: number
  rawSize?: number
  raw_size?: number
  flag?: number
}

export type NativeDatMeta = {
  version?: number
  aesSize?: number
  aes_size?: number
  xorSize?: number
  xor_size?: number
  rawSize?: number
  raw_size?: number
  flag?: number
}

type NativeAddon = {
  decryptDatNative: (inputPath: string, xorKey: number, aesKey?: string) => NativeDecryptResult
  encryptDatNative?: (inputPath: string, xorKey: number, aesKey?: string, meta?: NativeDatMeta) => Buffer
}

let cachedAddon: NativeAddon | null | undefined

function shouldEnableNative(): boolean {
  return process.env.WEFLOW_IMAGE_NATIVE !== '0'
}

function expandAsarCandidates(filePath: string): string[] {
  if (!filePath.includes('app.asar') || filePath.includes('app.asar.unpacked')) {
    return [filePath]
  }
  return [filePath.replace('app.asar', 'app.asar.unpacked'), filePath]
}

function getPlatformDir(): string {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  return process.platform
}

function getArchDir(): string {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

function getAddonCandidates(): string[] {
  const platformDir = getPlatformDir()
  const archDir = getArchDir()
  const cwd = process.cwd()
  const fileNames = [
    `weflow-image-native-${platformDir}-${archDir}.node`
  ]
  const roots = [
    join(cwd, 'resources', 'wedecrypt', platformDir, archDir),
    ...(process.resourcesPath
      ? [
          join(process.resourcesPath, 'resources', 'wedecrypt', platformDir, archDir),
          join(process.resourcesPath, 'wedecrypt', platformDir, archDir)
        ]
      : [])
  ]
  const candidates = roots.flatMap((root) => fileNames.map((name) => join(root, name)))
  return Array.from(new Set(candidates.flatMap(expandAsarCandidates)))
}

function loadAddon(): NativeAddon | null {
  if (!shouldEnableNative()) return null
  if (cachedAddon !== undefined) return cachedAddon

  for (const candidate of getAddonCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const addon = require(candidate) as NativeAddon
      if (addon && typeof addon.decryptDatNative === 'function') {
        cachedAddon = addon
        return addon
      }
    } catch {
      // try next candidate
    }
  }

  cachedAddon = null
  return null
}

export function nativeAddonLocation(): string | null {
  for (const candidate of getAddonCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function decryptDatViaNative(
  inputPath: string,
  xorKey: number,
  aesKey?: string
): { data: Buffer; ext: string; isWxgf: boolean; meta: NativeDatMeta } | null {
  const addon = loadAddon()
  if (!addon) return null

  try {
    const result = addon.decryptDatNative(inputPath, xorKey, aesKey)
    const isWxgf = Boolean(result?.isWxgf ?? result?.is_wxgf)
    if (!result || !Buffer.isBuffer(result.data)) return null
    const rawExt = typeof result.ext === 'string' && result.ext.trim()
      ? result.ext.trim().toLowerCase()
      : ''
    const ext = rawExt ? (rawExt.startsWith('.') ? rawExt : `.${rawExt}`) : ''
    const meta: NativeDatMeta = {
      version: result.version,
      aes_size: result.aes_size ?? result.aesSize,
      xor_size: result.xor_size ?? result.xorSize,
      raw_size: result.raw_size ?? result.rawSize,
      flag: result.flag
    }
    return { data: result.data, ext, isWxgf, meta }
  } catch {
    return null
  }
}

export function encryptDatViaNative(
  inputPath: string,
  xorKey: number,
  aesKey?: string,
  meta?: NativeDatMeta
): Buffer | null {
  const addon = loadAddon()
  if (!addon || typeof addon.encryptDatNative !== 'function') return null

  try {
    const result = addon.encryptDatNative(inputPath, xorKey, aesKey, meta)
    return Buffer.isBuffer(result) ? result : null
  } catch {
    return null
  }
}

// ─── Worker 化解密：原生解密是同步 CPU/IO 调用，滚动时批量触发会阻塞主线程 ───

type WorkerDecryptResult = { data: Buffer; ext: string; isWxgf: boolean; meta: NativeDatMeta } | null

type PendingJob = {
  resolve: (value: WorkerDecryptResult) => void
}

let decryptWorker: Worker | null = null
let workerFailedPermanently = false
let workerJobSeq = 0
const pendingJobs = new Map<number, PendingJob>()

function resolveWorkerPath(): string | null {
  const isDev = process.env.NODE_ENV === 'development'
  const candidates = isDev
    ? [join(__dirname, '../dist-electron/imageDecryptWorker.js'), join(__dirname, 'imageDecryptWorker.js')]
    : [join(__dirname, 'imageDecryptWorker.js')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function flushPendingJobs(): void {
  for (const job of pendingJobs.values()) job.resolve(null)
  pendingJobs.clear()
}

function ensureDecryptWorker(): Worker | null {
  if (workerFailedPermanently) return null
  if (decryptWorker) return decryptWorker

  const workerPath = resolveWorkerPath()
  if (!workerPath) {
    workerFailedPermanently = true
    return null
  }

  try {
    const worker = new Worker(workerPath, {
      workerData: { resourcesPath: process.resourcesPath || '' }
    })
    worker.on('message', (msg: { id: number; ok: boolean; addonMissing?: boolean; data?: ArrayBuffer; ext?: string; isWxgf?: boolean; meta?: NativeDatMeta }) => {
      const job = pendingJobs.get(msg.id)
      if (!job) return
      pendingJobs.delete(msg.id)
      if (msg.addonMissing) {
        // worker 中找不到原生模块：停用 worker 路径，后续直接走主线程同步逻辑
        workerFailedPermanently = true
        terminateDecryptWorker()
        job.resolve(null)
        return
      }
      if (!msg.ok || !msg.data) {
        job.resolve(null)
        return
      }
      job.resolve({
        data: Buffer.from(msg.data),
        ext: msg.ext || '',
        isWxgf: Boolean(msg.isWxgf),
        meta: msg.meta || {}
      })
    })
    const handleWorkerGone = () => {
      flushPendingJobs()
      decryptWorker = null
    }
    worker.on('error', handleWorkerGone)
    worker.on('exit', handleWorkerGone)
    worker.unref()
    decryptWorker = worker
    return worker
  } catch {
    workerFailedPermanently = true
    return null
  }
}

/**
 * 在 worker 线程中执行原生 DAT 解密，不阻塞主线程。
 * worker 不可用时回退为主线程同步解密（行为与旧版一致）。
 */
export async function decryptDatViaNativeAsync(
  inputPath: string,
  xorKey: number,
  aesKey?: string
): Promise<WorkerDecryptResult> {
  if (!shouldEnableNative()) return null

  const worker = ensureDecryptWorker()
  if (!worker) {
    return decryptDatViaNative(inputPath, xorKey, aesKey)
  }

  const id = ++workerJobSeq
  return new Promise<WorkerDecryptResult>((resolve) => {
    pendingJobs.set(id, { resolve })
    try {
      worker.postMessage({ id, datPath: inputPath, xorKey, aesKey })
    } catch {
      pendingJobs.delete(id)
      resolve(decryptDatViaNative(inputPath, xorKey, aesKey))
    }
  })
}

export function terminateDecryptWorker(): void {
  if (decryptWorker) {
    void decryptWorker.terminate()
    decryptWorker = null
  }
  flushPendingJobs()
}
