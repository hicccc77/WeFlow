import { appendAiAnalysisLog, appendAiAnalysisSystemLog, clearExpiredAiAnalysisLogs } from './storage'
import type { AiAnalysisLogEntry } from './types'

const buildId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const write = async (
  taskId: string,
  level: AiAnalysisLogEntry['level'],
  step: string,
  message: string,
  payload?: unknown,
  code?: string,
  durationMs?: number
) => {
  await clearExpiredAiAnalysisLogs()
  await appendAiAnalysisLog({
    id: buildId(),
    taskId,
    level,
    step,
    message,
    payload,
    code,
    durationMs,
    createdAt: Date.now()
  })
  await appendAiAnalysisSystemLog({
    id: buildId(),
    taskId,
    level,
    step,
    message,
    payload,
    code,
    durationMs,
    createdAt: Date.now()
  })
}

export const aiAnalysisLogger = {
  info: (taskId: string, step: string, message: string, payload?: unknown, code?: string, durationMs?: number) =>
    write(taskId, 'info', step, message, payload, code, durationMs),
  warn: (taskId: string, step: string, message: string, payload?: unknown, code?: string, durationMs?: number) =>
    write(taskId, 'warn', step, message, payload, code, durationMs),
  error: (taskId: string, step: string, message: string, payload?: unknown, code?: string, durationMs?: number) =>
    write(taskId, 'error', step, message, payload, code, durationMs)
}
