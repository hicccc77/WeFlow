import { parentPort, workerData } from 'worker_threads'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { agentService, type AgentMode, type AgentModelConfig, type AgentScope } from './services/agentService'
import {
  synthesizeAgentMemoryFromConversation,
  type AgentMemoryConversationExchange,
} from './services/agentMemorySynthesisService'
import { agentMemoryStore } from './services/agentMemoryService'
import { chatService } from './services/chatService'
import { imageDecryptService } from './services/imageDecryptService'
import { snsService } from './services/snsService'
import { wcdbService } from './services/wcdbService'

type AgentRunWorkerData = {
  runId: string
  resumeFromRunId?: string
  conversationId?: number | null
  messages: any[]
  scope: AgentScope
  mode: AgentMode
  modelConfig: AgentModelConfig
  resourcesPath?: string
  userDataPath?: string
  databaseConfig?: {
    dbPath?: string
    decryptKey?: string
    myAccountId?: string
    imageXorKey?: unknown
    imageAesKey?: string
    resourcesPath?: string
    appPath?: string
    isPackaged?: boolean
  }
  logEnabled?: boolean
  agentDebugLogEnabled?: boolean
  wcdbLibPath?: string
}

let controller: AbortController | null = null
let started = false

function recordWorkerFailure(userDataPath: string | undefined, runId: string, error: unknown): void {
  const root = String(userDataPath || process.env.WEFLOW_USER_DATA_PATH || '').trim()
  if (!root) return
  try {
    const directory = join(root, 'logs')
    mkdirSync(directory, { recursive: true })
    const source = error instanceof Error ? error : new Error(String(error || 'Agent 运行失败'))
    appendFileSync(join(directory, 'agent-worker-errors.jsonl'), `${JSON.stringify({
      at: Date.now(),
      runId,
      name: source.name,
      message: source.message.slice(0, 2_000),
      stack: String(source.stack || '').slice(0, 12_000),
    })}\n`, 'utf8')
  } catch {
    // 诊断日志和失败态修复都不能掩盖原始错误。
  }
}

function send(message: unknown): void {
  if (parentPort) parentPort.postMessage(message)
  else if (typeof process.send === 'function') process.send(message)
}

function recentMemoryExchanges(excludeRunId: string, limit = 12): AgentMemoryConversationExchange[] {
  return agentService.listRecentRunSnapshots(Math.max(limit * 2, 24))
    .filter((run) => run.runId !== excludeRunId && run.status === 'completed' && run.outcome === 'answered')
    .filter((run) => Boolean(run.question && run.finalAnswer))
    .sort((left, right) => Number(left.finishedAt || left.updatedAt || 0) - Number(right.finishedAt || right.updatedAt || 0))
    .slice(-limit)
    .map((run) => ({
      turnId: run.runId,
      occurredAt: Number(run.finishedAt || run.updatedAt || 0) || undefined,
      userText: run.question,
      assistantText: run.finalAnswer!,
    }))
}

async function run(config: AgentRunWorkerData) {
  if (started) return
  started = true
  controller = new AbortController()
  wcdbService.setPaths(String(config.resourcesPath || ''), String(config.userDataPath || ''))
  wcdbService.setLibPath(String(config.wcdbLibPath || ''))
  wcdbService.setLogEnabled(config.logEnabled === true)
  chatService.setRuntimeConfig(config.databaseConfig || {})
  imageDecryptService.setRuntimeConfig({
    dbPath: config.databaseConfig?.dbPath,
    myAccountId: config.databaseConfig?.myAccountId,
    imageXorKey: config.databaseConfig?.imageXorKey,
    imageAesKey: config.databaseConfig?.imageAesKey,
  })
  snsService.setRuntimeConfig(config.databaseConfig || {})

  let result: { type: 'result'; success: boolean; error?: string; aborted?: boolean }
  try {
    await agentService.run({
      runId: config.runId,
      resumeFromRunId: config.resumeFromRunId,
      conversationId: config.conversationId,
      messages: Array.isArray(config.messages) ? config.messages : [],
      scope: config.scope?.kind ? config.scope : { kind: 'global' },
      mode: config.mode === 'deep-research' ? 'deep-research' : 'standard',
      modelConfig: config.modelConfig || {},
      debugLogEnabled: config.agentDebugLogEnabled === true,
      runtimeDataContext: {
        myAccountId: config.databaseConfig?.myAccountId,
        dbPath: config.databaseConfig?.dbPath,
        cacheEncryptionSecret: config.databaseConfig?.decryptKey,
      },
      signal: controller.signal,
      onChunk: (chunk) => send({ type: 'chunk', chunk }),
      onProgress: (progress) => send({ type: 'progress', progress }),
    })
    try {
      const completedRun = agentService.loadRunState(config.runId)
      const memoryResult = await synthesizeAgentMemoryFromConversation({
        messages: Array.isArray(config.messages) ? config.messages : [],
        assistantAnswer: completedRun?.finalAnswer,
        occurredAt: Number(completedRun?.finishedAt || completedRun?.updatedAt || Date.now()),
        modelConfig: config.modelConfig,
        turnId: config.runId,
        recentExchanges: recentMemoryExchanges(config.runId),
      })
      if (memoryResult.summary) {
        send({ type: 'memory-updated', summary: memoryResult.summary })
      }
    } catch (memoryError) {
      recordWorkerFailure(config.userDataPath, config.runId, new Error(
        `记忆更新失败，但 Agent 回答已正常完成：${memoryError instanceof Error ? memoryError.message : String(memoryError || '未知错误')}`,
      ))
      try {
        send({ type: 'memory-updated', summary: agentMemoryStore.recordReviewFailure(memoryError) })
      } catch {
        // 记忆状态写入失败不能反过来把已经完成的 Agent 回答标为失败。
      }
    }
    result = { type: 'result', success: true }
  } catch (error) {
    const message = controller.signal.aborted
      ? '已停止'
      : error instanceof Error
        ? error.message
        : String(error || 'AI 回答失败')
    agentService.failIncompleteRun(config.runId, error, controller.signal.aborted)
    recordWorkerFailure(config.userDataPath, config.runId, error)
    result = { type: 'result', success: false, error: message, aborted: controller.signal.aborted }
  } finally {
    await wcdbService.shutdown().catch(() => {})
  }
  send(result)
  // 不要用固定定时器终止这个派生进程。`process.send()` 只是把消息加入队列，
  // 高负载时，任意延时退出可能早于 IPC 消息真正送达。该生命周期由 Electron
  // 主进程负责：只有收到这个终态结果后，主进程才会断开或终止子进程。
}

function handleControlMessage(message: { type?: string; config?: AgentRunWorkerData }): void {
  if (message?.type === 'abort') {
    controller?.abort()
    return
  }
  if (message?.type === 'start' && message.config) void run(message.config)
}

parentPort?.on('message', handleControlMessage)
process.on('message', handleControlMessage)

// 为开发环境和专项测试保留兼容旧版的 worker_threads 启动方式。
if (parentPort && workerData) void run(workerData as AgentRunWorkerData)
