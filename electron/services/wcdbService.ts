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
          const errorMsg = `Worker 异常退出 (退出码: ${code})。可能是数据服务加载失败，请检查是否安装了 Visual C++ Redistributable。`
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
    this.callWorker<{ success?: boolean }>('setMonitor').catch(() => { });
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

  async getLastInitError(): Promise<string | null> {
    return this.callWorker('getLastInitError')
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
  async shutdown(): Promise<void> {
    try { await this.close() } catch {}
    if (this.worker) {
      try { await this.worker.terminate() } catch {}
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

  async getMessageCounts(sessionIds: string[]): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    return this.callWorker('getMessageCounts', { sessionIds })
  }

  async getSessionMessageCounts(sessionIds: string[]): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    return this.callWorker('getSessionMessageCounts', { sessionIds })
  }

  async getSessionMessageTypeStats(
    sessionId: string,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getSessionMessageTypeStats', { sessionId, beginTimestamp, endTimestamp })
  }

  async getSessionMessageTypeStatsBatch(
    sessionIds: string[],
    options?: {
      beginTimestamp?: number
      endTimestamp?: number
      quickMode?: boolean
      includeGroupSenderCount?: boolean
    }
  ): Promise<{ success: boolean; data?: Record<string, any>; error?: string }> {
    return this.callWorker('getSessionMessageTypeStatsBatch', { sessionIds, options })
  }

  async getSessionMessageDateCounts(sessionId: string): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    return this.callWorker('getSessionMessageDateCounts', { sessionId })
  }

  async getSessionMessageDateCountsBatch(sessionIds: string[]): Promise<{ success: boolean; data?: Record<string, Record<string, number>>; error?: string }> {
    return this.callWorker('getSessionMessageDateCountsBatch', { sessionIds })
  }

  async getMessagesByType(
    sessionId: string,
    localType: number,
    ascending = false,
    limit = 0,
    offset = 0
  ): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.callWorker('getMessagesByType', { sessionId, localType, ascending, limit, offset })
  }

  async getMediaStream(options?: {
    sessionId?: string
    mediaType?: 'image' | 'video' | 'all'
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }): Promise<{
    success: boolean
    items?: Array<{
      sessionId: string
      sessionDisplayName?: string
      mediaType: 'image' | 'video'
      localId: number
      serverId?: string
      createTime: number
      localType: number
      senderUsername?: string
      isSend?: number | null
      imageMd5?: string
      imageDatName?: string
      videoMd5?: string
      content?: string
    }>
    hasMore?: boolean
    nextOffset?: number
    error?: string
  }> {
    return this.callWorker('getMediaStream', { options })
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

  async getMessageTableColumns(dbPath: string, tableName: string): Promise<{ success: boolean; columns?: string[]; error?: string }> {
    return this.callWorker('getMessageTableColumns', { dbPath, tableName })
  }

  async getMessageTableTimeRange(dbPath: string, tableName: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getMessageTableTimeRange', { dbPath, tableName })
  }

  /**
   * 获取联系人详情
   */
  async getContact(username: string): Promise<{ success: boolean; contact?: any; error?: string }> {
    return this.callWorker('getContact', { username })
  }

  /**
   * 批量获取联系人 extra_buffer 状态（isFolded/isMuted）
   */
  async getContactStatus(usernames: string[]): Promise<{ success: boolean; map?: Record<string, { isFolded: boolean; isMuted: boolean }>; error?: string }> {
    return this.callWorker('getContactStatus', { usernames })
  }

  async getContactTypeCounts(): Promise<{ success: boolean; counts?: { private: number; group: number; official: number; former_friend: number }; error?: string }> {
    return this.callWorker('getContactTypeCounts')
  }

  async getContactsCompact(usernames: string[] = []): Promise<{ success: boolean; contacts?: any[]; error?: string }> {
    return this.callWorker('getContactsCompact', { usernames })
  }

  async getContactAliasMap(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    return this.callWorker('getContactAliasMap', { usernames })
  }

  async getContactFriendFlags(usernames: string[]): Promise<{ success: boolean; map?: Record<string, boolean>; error?: string }> {
    return this.callWorker('getContactFriendFlags', { usernames })
  }

  async getChatRoomExtBuffer(chatroomId: string): Promise<{ success: boolean; extBuffer?: string; error?: string }> {
    return this.callWorker('getChatRoomExtBuffer', { chatroomId })
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
   * 执行 SQL 查询（仅主进程内部使用：fallback/diagnostic/低频兼容）
   */
  async execQuery(kind: string, path: string | null, sql: string, params: any[] = []): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.callWorker('execQuery', { kind, path, sql, params })
  }

  /**
   * 获取表情包 CDN URL
   */
  async getEmoticonCdnUrl(dbPath: string, md5: string): Promise<{ success: boolean; url?: string; error?: string }> {
    return this.callWorker('getEmoticonCdnUrl', { dbPath, md5 })
  }

  /**
   * 获取表情包释义
   */
  async getEmoticonCaption(dbPath: string, md5: string): Promise<{ success: boolean; caption?: string; error?: string }> {
    return this.callWorker('getEmoticonCaption', { dbPath, md5 })
  }

  /**
   * 获取表情包释义（严格数据服务接口）
   */
  async getEmoticonCaptionStrict(md5: string): Promise<{ success: boolean; caption?: string; error?: string }> {
    return this.callWorker('getEmoticonCaptionStrict', { md5 })
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

  async searchMessages(keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    return this.callWorker('searchMessages', { keyword, sessionId, limit, offset, beginTimestamp, endTimestamp })
  }

  /**
   * 获取语音数据
   */
  async getVoiceData(sessionId: string, createTime: number, candidates: string[], localId: number = 0, svrId: string | number = 0): Promise<{ success: boolean; hex?: string; error?: string }> {
    return this.callWorker('getVoiceData', { sessionId, createTime, candidates, localId, svrId })
  }

  async getVoiceDataBatch(
    requests: Array<{ session_id: string; create_time: number; local_id?: number; svr_id?: string | number; candidates?: string[] }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; hex?: string }>; error?: string }> {
    return this.callWorker('getVoiceDataBatch', { requests })
  }

  async getMediaSchemaSummary(dbPath: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('getMediaSchemaSummary', { dbPath })
  }

  async getHeadImageBuffers(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    return this.callWorker('getHeadImageBuffers', { usernames })
  }

  async resolveImageHardlink(md5: string, accountDir?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('resolveImageHardlink', { md5, accountDir })
  }

  async resolveImageHardlinkBatch(
    requests: Array<{ md5: string; accountDir?: string }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; md5: string; success: boolean; data?: any; error?: string }>; error?: string }> {
    return this.callWorker('resolveImageHardlinkBatch', { requests })
  }

  async resolveVideoHardlinkMd5(md5: string, dbPath?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.callWorker('resolveVideoHardlinkMd5', { md5, dbPath })
  }

  async resolveVideoHardlinkMd5Batch(
    requests: Array<{ md5: string; dbPath?: string }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; md5: string; success: boolean; data?: any; error?: string }>; error?: string }> {
    return this.callWorker('resolveVideoHardlinkMd5Batch', { requests })
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

  async getSnsUsernames(): Promise<{ success: boolean; usernames?: string[]; error?: string }> {
    return this.callWorker('getSnsUsernames')
  }

  async getSnsExportStats(myWxid?: string): Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }> {
    return this.callWorker('getSnsExportStats', { myWxid })
  }

  async checkMessageAntiRevokeTriggers(
    sessionIds: string[]
  ): Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>; error?: string }> {
    return this.callWorker('checkMessageAntiRevokeTriggers', { sessionIds })
  }

  async installMessageAntiRevokeTriggers(
    sessionIds: string[]
  ): Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>; error?: string }> {
    return this.callWorker('installMessageAntiRevokeTriggers', { sessionIds })
  }

  async uninstallMessageAntiRevokeTriggers(
    sessionIds: string[]
  ): Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; error?: string }>; error?: string }> {
    return this.callWorker('uninstallMessageAntiRevokeTriggers', { sessionIds })
  }

  /**
   * 安装朋友圈删除拦截
   */
  async installSnsBlockDeleteTrigger(): Promise<{ success: boolean; alreadyInstalled?: boolean; error?: string }> {
    return this.callWorker('installSnsBlockDeleteTrigger')
  }

  /**
   * 卸载朋友圈删除拦截
   */
  async uninstallSnsBlockDeleteTrigger(): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('uninstallSnsBlockDeleteTrigger')
  }

  /**
   * 查询朋友圈删除拦截是否已安装
   */
  async checkSnsBlockDeleteTrigger(): Promise<{ success: boolean; installed?: boolean; error?: string }> {
    return this.callWorker('checkSnsBlockDeleteTrigger')
  }

  /**
   * 从数据库直接删除朋友圈记录
   */
  async deleteSnsPost(postId: string): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('deleteSnsPost', { postId })
  }

  /**
   * 获取数据服务内部日志
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
   * 修改消息内容
   */
  async updateMessage(sessionId: string, localId: number, createTime: number, newContent: string): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('updateMessage', { sessionId, localId, createTime, newContent })
  }

  /**
   * 删除消息
   */
  async deleteMessage(sessionId: string, localId: number, createTime: number, dbPathHint?: string): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('deleteMessage', { sessionId, localId, createTime, dbPathHint })
  }

  /**
   * 数据收集：初始化
   */
  async cloudInit(intervalSeconds: number): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('cloudInit', { intervalSeconds })
  }

  /**
   * 数据收集：上报数据
   */
  async cloudReport(statsJson: string): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('cloudReport', { statsJson })
  }

  /**
   * 数据收集：停止
   */
  cloudStop(): Promise<{ success: boolean; error?: string }> {
    return this.callWorker('cloudStop', {})
  }



}

export const wcdbService = new WcdbService()
