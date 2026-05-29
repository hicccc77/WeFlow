import { parentPort } from 'worker_threads'
import { mapRowsToMessagesLite } from './services/apiMessageMapping'

/**
 * apiMessageWorker —— HTTP API 消息映射的 CPU worker。
 *
 * 只做一件事：把一批原始数据库行（message_content / compress_content 等）解码并映射成
 * Message[]（hex/zstd 解压、字符清洗、key 构造）。这是纯 CPU 工作、无原生依赖、无数据库访问，
 * 因此可以安全地脱离主进程，在多个 worker 上并行运行（见 apiMessageMapperPool.ts），
 * 既不阻塞 WeFlow 本体，又能按核数提速大批量消息的获取。
 *
 * 协议：收到 { id, rows, myWxid } -> 回 { id, result: Message[] } 或 { id, error: string }。
 */
if (parentPort) {
  parentPort.on('message', (msg: { id: number; rows: Record<string, any>[]; myWxid: string }) => {
    const { id, rows, myWxid } = msg
    try {
      const result = mapRowsToMessagesLite(Array.isArray(rows) ? rows : [], String(myWxid || ''))
      parentPort!.postMessage({ id, result })
    } catch (e) {
      parentPort!.postMessage({ id, error: String(e) })
    }
  })
}
