import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { redactAgentValueForLog } from './agentTextRedaction'

const MAX_EVENT_CHARS = 48_000
const MAX_LOG_BYTES = 2 * 1024 * 1024

function safeRunId(value: string): string {
  return String(value || 'run').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'run'
}

function boundedJson(value: unknown): string {
  let serialized = ''
  try {
    serialized = JSON.stringify(redactAgentValueForLog(value), (_key, nested) => {
      if (typeof nested === 'string' && nested.length > 12_000) {
        return `${nested.slice(0, 7_200)}\n…[调试字段已裁剪]…\n${nested.slice(-4_000)}`
      }
      if (Array.isArray(nested) && nested.length > 80) {
        return [...nested.slice(0, 60), { debugTruncatedItems: nested.length - 70 }, ...nested.slice(-10)]
      }
      return nested
    })
  } catch (error) {
    serialized = JSON.stringify({ serializationError: String(error || '未知序列化错误') })
  }
  if (serialized.length <= MAX_EVENT_CHARS) return serialized
  return JSON.stringify({
    debugTruncated: true,
    originalChars: serialized.length,
    preview: `${serialized.slice(0, 30_000)}\n…[调试事件已裁剪]…\n${serialized.slice(-12_000)}`,
  })
}

export class AgentDebugLog {
  readonly filePath: string
  private bytesWritten = 0
  private closed = false

  constructor(rootDir: string, runId: string) {
    const directory = join(rootDir, 'logs', 'agent-runs')
    mkdirSync(directory, { recursive: true })
    this.filePath = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeRunId(runId)}.jsonl`)
    const header = `${JSON.stringify({ schema: 'weflow-agent-debug-v1', runId, createdAt: Date.now() })}\n`
    writeFileSync(this.filePath, header, 'utf8')
    this.bytesWritten = Buffer.byteLength(header)
  }

  event(type: string, data: unknown = {}): void {
    if (this.closed) return
    try {
      const line = `${boundedJson({ at: Date.now(), type, data })}\n`
      const bytes = Buffer.byteLength(line)
      if (this.bytesWritten + bytes > MAX_LOG_BYTES) {
        const ending = `${JSON.stringify({ at: Date.now(), type: 'debug_log.truncated', data: { maxBytes: MAX_LOG_BYTES } })}\n`
        appendFileSync(this.filePath, ending, 'utf8')
        this.bytesWritten += Buffer.byteLength(ending)
        this.closed = true
        return
      }
      appendFileSync(this.filePath, line, 'utf8')
      this.bytesWritten += bytes
    } catch {
      // 诊断日志绝不能中断用户正在执行的智能体任务。
      this.closed = true
    }
  }
}

export function createAgentDebugLog(rootDir: string, runId: string): AgentDebugLog | null {
  try {
    return new AgentDebugLog(rootDir, runId)
  } catch {
    return null
  }
}
