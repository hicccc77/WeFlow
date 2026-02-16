import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * Worker 消息接口
 */
interface WorkerMessage {
  id: number
  result?: any
  error?: string
}

/**
 * WCDB 服务 (客户端代理)
 * 负责与后台 Worker 线程通信，执行数据库操作
 * 避免主进程阻塞
 */
export class WcdbService {
  private worker: Worker | null = null
  private messageId = 0
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>()
  private resourcesPath: string | null = null
  private userDataPath: string | null = null
  private logEnabled = false
  private monitorListener: ((type: string, json: string) => void) | null = null

  constructor() {
    this.initWorker()
  }

  /**
   * 初始化 Worker 线程
   */
  private initWorker() {
    if (this.worker) return

    const isDev = process.env.NODE_ENV === 'development'
    const workerPath = isDev
      ? join(__dirname, '../dist-electron/wcdbWorker.js')
      : join(__dirname, 'wcdbWorker.js')

    let finalPath = workerPath
    if (isDev && !existsSync(finalPath)) {
      finalPath = join(__dirname, 'wcdbWorker.js')
    }

    try {
      this.worker = new Worker(finalPath)

      this.worker.on('message', (msg: any) => {
        const { id, result, error, type, payload } = msg

        if (type === 'monitor') {
          if (this.monitorListener) {
            this.monitorListener(payload.type, payload.json)
          }
          return
        }

        const p = this.pending.get(id)
        if (p) {
          this.pending.delete(id)
          if (error) p.reject(new Error(error))
          else p.resolve(result)
        }
      })

      this.worker.on('error', (err) => {
        // Worker 发生错误，需要 reject 所有 pending promises
        console.error('WCDB Worker 错误:', err)
        const errorMsg = err instanceof Error ? err.message : String(err)
        for (const [id, p] of this.pending) {
          p.reject(new Error(`Worker 错误: ${errorMsg}`))
        }
        this.pending.clear()
      })

      this.worker.on('exit', (code) => {
        // Worker 退出，需要 reject 所有 pending promises
        if (code !== 0) {
          console.error('WCDB Worker 异常退出，退出码:', code)
          const errorMsg = `Worker 异常退出 (退出码: ${code})。可能是 DLL 加载失败，请检查是否安装了 Visual C++ Redistributable。`
          for (const [id, p] of this.pending) {
            p.reject(new Error(errorMsg))
          }
          this.pending.clear()
        }
        this.worker = null
      })

      // 如果已有路径配置，重新发送给新的 worker
      if (this.resourcesPath && this.userDataPath) {
        this.setPaths(this.resourcesPath, this.userDataPath)
      }
      this.setLogEnabled(this.logEnabled)

    } catch (e) {
      // Failed to create worker
    }
  }

  /**
   * 发送消息到 Worker 并等待响应
   */
  private callWorker<T>(type: string, payload: any = {}): Promise<T> {
    if (!this.worker) this.initWorker()
    if (!this.worker) return Promise.reject(new Error('WCDB Worker 不可用'))

    return new Promise((resolve, reject) => {
      const id = ++this.messageId
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, type, payload })
    })
  }

  /**
   * 设置资源路径
   */
  setPaths(resourcesPath: string, userDataPath: string): void {
    this.resourcesPath = resourcesPath
    this.userDataPath = userDataPath
    this.callWorker('setPaths', { resourcesPath, userDataPath }).catch(() => { })
  }

  /**
   * 启用/禁用日志
   */
  setLogEnabled(enabled: boolean): void {
    this.logEnabled = enabled
    this.callWorker('setLogEnabled', { enabled }).catch(() => { })
  }

  /**
   * 设置数据库监控回调
   */
  setMonitor(callback: (type: string, json: string) => void): void {
    this.monitorListener = callback;
    // Notify worker to enable monitor
    this.callWorker('setMonitor').catch(() => { });
  }

  /**
   * 检查服务是否就绪
   */
  isReady(): boolean {
    return !!this.worker
  }

  // ==========================================
  // 代理方法 (Proxy Methods)
  // ==========================================

  /**
   * 测试数据库连接
   */
  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    return this.callWorker('testConnection', { dbPath, hexKey, wxid })
  }

  /**
   * 打开数据库
   */
  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    return this.callWorker('open', { dbPath, hexKey, wxid })
  }

  /**
   * 关闭数据库连接
   */
  async close(): Promise<void> {
    return this.callWorker('close')
  }

  /**
   * 关闭服务
   */
  shutdown(): void {
    this.close()
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
  }

  /**
   * 获取数据库连接状态
   * 注意：此方法现在是异步的
   */
  async isConnected(): Promise<boolean> {
    return this.callWorker('isConnected')
  }

  /**
   * 获取会话列表
   */
  async getSessions(): Promise<{ success: boolean; sessions?: any[]; error?: string }> {
    return this.callWorker('getSessions')
  }

  /**
   * 获取消息列表
   */
  async getMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    return this.callWorker('getMessages', { sessionId, limit, offset })
  }

  /**
   * 获取新消息（增量刷新）
   */
  async getNewMessages(sessionId: string, minTime: number, limit: number = 1000): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    return this.callWorker('getNewMessages', { sessionId, minTime, limit })
  }

  /**
   * 获取消息总数
   */
  async getMessageCount(sessionId: string): Promise<{ success: boolean; count?: number; error?: string }> {
    return this.callWorker('getMessageCount', { sessionId })
  }

  /**
   * 获取联系人昵称
   */
  async getDisplayNames(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    return this.callWorker('getDisplayNames', { usernames })
  }

  /**
   * 获取头像 URL
   */
  async getAvatarUrls(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    return this.callWorker('getAvatarUrls', { usernames })
  }

  /**
   * 获取群成员数量
   */
  async getGroupMemberCount(chatroomId: string): Promise<{ success: boolean; count?: number; error?: string }> {
    return this.callWorker('getGroupMemberCount', { chatroomId })
  }

  /**
   * 批量获取群成员数量
   */
  async getGroupMemberCounts(chatroomIds: string[]): Promise<{ success: boolean; map?: Record<string, number>; error?: string }> {
    return this.callWorker('getGroupMemberCounts', { chatroomIds })
  }

  /**
   * 获取群成员列表
   */
  async getGroupMembers(chatroomId: string): Promise<{ success: boolean; members?: any[]; error?: string }> {
    return this.callWorker('getGroupMembers', { chatroomId })
  }

  // 获取群成员群名片昵称
  async getGroupNicknames(chatroomId: string): Promise<{ success: boolean; nicknames?: Record<string, string>; error?: string }> {
    return this.callWorker('getGroupNicknames', { chatroomId })
  }

  /**
   * 获取消息表列表
   */
  async getMessageTables(sessionId: string): Promise<{ success: boolean; tables?: any[]; error?: string }> {
    return this.callWorker('getMessageTables', { sessionId })
  }

  /**
   * 获取消息表统计
   */
  async getMessageTableStats(sessionId: string): Promise<{ success: boolean; tables?: any[]; error?: string }> {
    return this.callWorker('getMessageTableStats', { sessionId })
  }

  async getMessageDates(sessionId: string): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    return this.callWorker('getMessageDates', { sessionId })
  }

  /**
   * 获取消息元数据
   */
  async getMessageMeta(dbPath: string, tableName: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.callWorker('getMessageMeta', { dbPath, tableName, limit, offset })
  }

  /**
   * 获取联系人详情
   */
  async getContact(username: string): Promise<{ success: boolean; contact?: any; error?: string }> {
    return this.callWorker('getContact', { username })
  }

  /**
   * 获取聚合统计数据
   */
  async getAggregateStats(sessionIds: string[], beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getAggregateStats', { sessionIds, beginTimestamp, endTimestamp })
  }

  /**
   * 获取可用年份
   */
  async getAvailableYears(sessionIds: string[]): Promise<{ success: boolean; data?: number[]; error?: string }> {
    return this.callWorker('getAvailableYears', { sessionIds })
  }

  /**
   * 获取年度报告统计
   */
  async getAnnualReportStats(sessionIds: string[], beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getAnnualReportStats', { sessionIds, beginTimestamp, endTimestamp })
  }

  /**
   * 获取年度报告扩展数据
   */
  async getAnnualReportExtras(sessionIds: string[], beginTimestamp: number, endTimestamp: number, peakDayBegin: number, peakDayEnd: number): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getAnnualReportExtras', { sessionIds, beginTimestamp, endTimestamp, peakDayBegin, peakDayEnd })
  }

  /**
   * 获取双人报告统计数据
   */
  async getDualReportStats(sessionId: string, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getDualReportStats', { sessionId, beginTimestamp, endTimestamp })
  }

  /**
   * 获取群聊统计
   */
  async getGroupStats(chatroomId: string, beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getGroupStats', { chatroomId, beginTimestamp, endTimestamp })
  }

  /**
   * 打开消息游标
   */
  async openMessageCursor(sessionId: string, batchSize: number, ascending: boolean, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; cursor?: number; error?: string }> {
    return this.callWorker('openMessageCursor', { sessionId, batchSize, ascending, beginTimestamp, endTimestamp })
  }

  /**
   * 打开轻量级消息游标
   */
  async openMessageCursorLite(sessionId: string, batchSize: number, ascending: boolean, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; cursor?: number; error?: string }> {
    return this.callWorker('openMessageCursorLite', { sessionId, batchSize, ascending, beginTimestamp, endTimestamp })
  }

  /**
   * 获取下一批消息
   */
  async fetchMessageBatch(cursor: number): Promise<{ success: boolean; rows?: any[]; hasMore?: boolean; error?: string }> {
    return this.callWorker('fetchMessageBatch', { cursor })
  }

  /**
   * 关闭消息游标
   */
  async closeMessageCursor(cursor: number): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('closeMessageCursor', { cursor })
  }

  /**
   * 执行 SQL 查询
   */
  async execQuery(kind: string, path: string | null, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.callWorker('execQuery', { kind, path, sql })
  }

  /**
   * 获取表情包 CDN URL
   */
  async getEmoticonCdnUrl(dbPath: string, md5: string): Promise<{ success: boolean; url?: string; error?: string }> {
    return this.callWorker('getEmoticonCdnUrl', { dbPath, md5 })
  }

  /**
   * 列出消息数据库
   */
  async listMessageDbs(): Promise<{ success: boolean; data?: string[]; error?: string }> {
    return this.callWorker('listMessageDbs')
  }

  /**
   * 列出媒体数据库
   */
  async listMediaDbs(): Promise<{ success: boolean; data?: string[]; error?: string }> {
    return this.callWorker('listMediaDbs')
  }

  /**
   * 根据 ID 获取消息
   */
  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: any; error?: string }> {
    return this.callWorker('getMessageById', { sessionId, localId })
  }

  /**
   * 获取语音数据
   */
  async getVoiceData(sessionId: string, createTime: number, candidates: string[], localId: number = 0, svrId: string | number = 0): Promise<{ success: boolean; hex?: string; error?: string }> {
    return this.callWorker('getVoiceData', { sessionId, createTime, candidates, localId, svrId })
  }

  /**
   * 获取朋友圈
   */
  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    return this.callWorker('getSnsTimeline', { limit, offset, usernames, keyword, startTime, endTime })
  }

  /**
   * 获取朋友圈年度统计
   */
  async getSnsAnnualStats(beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getSnsAnnualStats', { beginTimestamp, endTimestamp })
  }

  /**
   * 获取 DLL 内部日志
   */
  async getLogs(): Promise<{ success: boolean; logs?: string[]; error?: string }> {
    return this.callWorker('getLogs')
  }

  /**
   * 验证 Windows Hello
   */
  async verifyUser(message: string, hwnd?: string): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('verifyUser', { message, hwnd })
  }

  /**
   * 解密朋友圈图片
   */
  async decryptSnsImage(encryptedData: Buffer, key: string): Promise<Buffer> {
    return this.callWorker<Buffer>('decryptSnsImage', { encryptedData, key })
  }

}

export const wcdbService = new WcdbService()
