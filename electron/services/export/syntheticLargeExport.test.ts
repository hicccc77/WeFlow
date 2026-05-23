import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MessageStreamRow } from './messageStream'
import { writeTxtStream } from './streamingWriters'

class FileSink {
  private readonly stream: fs.WriteStream

  constructor(filePath: string) {
    this.stream = fs.createWriteStream(filePath, { encoding: 'utf-8' })
    this.stream.setMaxListeners(0)
  }

  async write(chunk: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.once('error', reject)
      if (!this.stream.write(chunk)) {
        this.stream.once('drain', resolve)
      } else {
        resolve()
      }
    })
  }

  async end(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.once('error', reject)
      this.stream.end(() => resolve())
    })
  }
}

const createdFiles: string[] = []

afterEach(() => {
  for (const filePath of createdFiles.splice(0)) {
    try { fs.rmSync(filePath, { force: true }) } catch {}
  }
})

describe('synthetic large streaming export', () => {
  it('writes 550k txt messages with bounded heap growth', async () => {
    const total = 550_000
    const outputPath = path.join(os.tmpdir(), `weflow-stream-${Date.now()}-${process.pid}.txt`)
    createdFiles.push(outputPath)

    let peakHeap = process.memoryUsage().heapUsed
    async function* generateRows(): AsyncGenerator<MessageStreamRow> {
      for (let i = 1; i <= total; i++) {
        if ((i % 5000) === 0) {
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
          await new Promise(resolve => setImmediate(resolve))
        }
        yield {
          localId: i,
          serverId: i,
          createTime: 1700000000 + i,
          localType: 1,
          content: `message ${i}`,
          senderUsername: i % 2 === 0 ? 'me' : 'friend',
          isSend: i % 2 === 0
        }
      }
    }

    const startHeap = process.memoryUsage().heapUsed
    const startedAt = Date.now()
    const result = await writeTxtStream(generateRows(), new FileSink(outputPath), {
      getSenderName: row => row.isSend ? '我' : 'friend',
      formatTimestamp: ts => String(ts),
      flushEvery: 512
    })
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)

    const stat = fs.statSync(outputPath)
    const heapGrowthMb = (peakHeap - startHeap) / 1024 / 1024
    const durationMs = Date.now() - startedAt
    console.info(`[syntheticLargeExport] messages=${result.messageCount} bytes=${stat.size} durationMs=${durationMs} heapGrowthMb=${heapGrowthMb.toFixed(1)}`)

    expect(result.messageCount).toBe(total)
    expect(stat.size).toBeGreaterThan(10 * 1024 * 1024)
    expect(heapGrowthMb).toBeLessThan(128)
  }, 120_000)
})
