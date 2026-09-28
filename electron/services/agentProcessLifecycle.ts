export type AgentProcessExitResolution =
  | {
      success: true
      completionSource: 'finish-chunk' | 'run-store'
    }
  | {
      success: false
      error: string
    }

/**
 * 根据流式结束标记和持久化运行状态判断后台进程是否正常完成。
 * 即使结束分片丢失，只要运行存储已确认完成，也不能把进程退出误报为失败。
 */
export function resolveAgentProcessExit(options: {
  code: number | null
  signal: string | null
  sawFinishChunk: boolean
  persistedStatus?: string | null
}): AgentProcessExitResolution {
  if (options.sawFinishChunk) {
    return { success: true, completionSource: 'finish-chunk' }
  }
  if (options.persistedStatus === 'completed') {
    return { success: true, completionSource: 'run-store' }
  }
  const reason = options.signal || (options.code == null ? '未知' : String(options.code))
  return { success: false, error: `Agent 后台进程意外退出（${reason}）` }
}
