import { parentPort, workerData } from 'worker_threads'
import { generateAgentTitle } from './services/agentTitleService'
import type { AgentModelConfig } from './services/agentService'

type AgentTitleWorkerData = {
  conversationText: string
  modelConfig?: AgentModelConfig
}

async function run(): Promise<void> {
  try {
    const input = (workerData || {}) as AgentTitleWorkerData
    const result = await generateAgentTitle(
      String(input.conversationText || ''),
      input.modelConfig,
    )
    parentPort?.postMessage({ type: 'result', success: true, ...result })
  } catch (error) {
    parentPort?.postMessage({
      type: 'result',
      success: false,
      generated: false,
      error: error instanceof Error ? error.message : String(error || '标题后台线程失败'),
    })
  }
}

void run()
