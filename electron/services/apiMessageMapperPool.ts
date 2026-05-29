import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'fs'
import type { Message } from './chatService'

/**
 * ApiMessageMapperPool —— HTTP API 消息映射的 worker 线程池。
 *
 * 把大批量「原始行 -> Message[]」的 CPU 解码/映射工作拆分到多个 worker 上并行执行
 * （见 apiMessageWorker.ts），使主进程在获取大量消息时既不卡顿（工作不在主线程），
 * 又能按核数提速。worker 是纯 JS（无原生依赖），任何崩溃/异常都会让 mapRows 抛错，
 * 由调用方回退到主线程映射，保证「最坏只是变慢、不会出错」。
 */

interface PendingTask {
  resolve: (value: Message[]) => void
  reject: (error: Error) => void
}

const MIN_CHUNK_ROWS = 200

export class ApiMessageMapperPool {
  private workers: Worker[] = []
  private pending = new Map<number, PendingTask>()
  private nextId = 1
  private readonly poolSize: number
  private started = false
  private disposed = false

  constructor(poolSize: number) {
    this.poolSize = Math.max(1, Math.floor(poolSize) || 1)
  }

  private resolveWorkerPath(): string {
    const isDev = process.env.NODE_ENV === 'development'
    const devPath = join(__dirname, '../dist-electron/apiMessageWorker.js')
    const prodPath = join(__dirname, 'apiMessageWorker.js')
    if (isDev && existsSync(devPath)) return devPath
    return prodPath
  }

  /** 拉起线程池（幂等）。worker 全部退出后会自动允许下次重新拉起。 */
  ensureStarted(): void {
    if (this.disposed) throw new Error('ApiMessageMapperPool 已释放')
    if (this.started && this.workers.length >= this.poolSize) return
    const workerPath = this.resolveWorkerPath()
    while (this.workers.length < this.poolSize) {
      this.spawnWorker(workerPath)
    }
    this.started = true
  }

  /** 预热：提前拉起 worker，使首个大请求无需等待 worker 启动。 */
  warmup(): void {
    try {
      this.ensureStarted()
    } catch {
      // 预热失败不致命，真正使用时再尝试，失败则主线程回退
    }
  }

  private spawnWorker(workerPath: string): void {
    const worker = new Worker(workerPath)
    worker.on('message', (msg: { id: number; result?: Message[]; error?: string }) => {
      const task = this.pending.get(msg.id)
      if (!task) return
      this.pending.delete(msg.id)
      if (msg.error) task.reject(new Error(msg.error))
      else task.resolve(Array.isArray(msg.result) ? msg.result : [])
    })
    worker.on('error', (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)))
      this.removeWorker(worker)
    })
    worker.on('exit', (code) => {
      if (code !== 0 && !this.disposed) {
        this.failAll(new Error(`apiMessageWorker 异常退出 (code=${code})`))
      }
      this.removeWorker(worker)
    })
    this.workers.push(worker)
  }

  private removeWorker(worker: Worker): void {
    const idx = this.workers.indexOf(worker)
    if (idx >= 0) this.workers.splice(idx, 1)
    if (this.workers.length === 0) {
      // 线程池已空：下次 ensureStarted 时重新拉起（崩溃自愈）
      this.started = false
    }
  }

  private failAll(err: Error): void {
    for (const [, task] of this.pending) {
      task.reject(err)
    }
    this.pending.clear()
  }

  private dispatch(worker: Worker, rows: Record<string, any>[], myWxid: string): Promise<Message[]> {
    return new Promise<Message[]>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      try {
        worker.postMessage({ id, rows, myWxid })
      } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /**
   * 并行映射：把 rows 切成若干连续分片分发到各 worker，按原始顺序拼接结果。
   * 任一分片失败 -> 整体 reject（调用方回退主线程）。
   */
  async mapRows(rows: Record<string, any>[], myWxid: string): Promise<Message[]> {
    if (!Array.isArray(rows) || rows.length === 0) return []
    this.ensureStarted()
    const workerCount = this.workers.length
    if (workerCount === 0) throw new Error('无可用的 apiMessageWorker')

    const chunkCount = Math.min(workerCount, Math.max(1, Math.ceil(rows.length / MIN_CHUNK_ROWS)))
    const chunkSize = Math.ceil(rows.length / chunkCount)

    const tasks: Promise<Message[]>[] = []
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize
      const slice = rows.slice(start, start + chunkSize)
      if (slice.length === 0) break
      const worker = this.workers[i % this.workers.length]
      tasks.push(this.dispatch(worker, slice, myWxid))
    }

    const results = await Promise.all(tasks)
    const out: Message[] = []
    for (const chunk of results) {
      for (let i = 0; i < chunk.length; i++) out.push(chunk[i])
    }
    return out
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.failAll(new Error('ApiMessageMapperPool 已释放'))
    const workers = this.workers.slice()
    this.workers = []
    this.started = false
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)))
  }
}
