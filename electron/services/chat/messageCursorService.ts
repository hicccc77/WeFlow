import { join } from 'path'
import { existsSync } from 'fs'
import { wcdbService } from '../wcdbService'
import { MessageCacheService } from '../messageCacheService'
import { emojiCache } from './constants'
import { mapRowsToMessages } from './messageMapper'
import { normalizeMessageOrder } from './messageRowUtils'
import type { Message } from './types'
import type { MessageCursorHost } from './messageCursorHost'

export class MessageCursorService {
  private messageCursors: Map<string, { cursor: number; fetched: number; batchSize: number; startTime?: number; endTime?: number; ascending?: boolean; bufferedMessages?: any[] }> = new Map()
  private messageCursorMutex = false
  private readonly messageBatchDefault = 50
  private readonly messageCursorSessionLimit = 8
  private readonly visibilityAnomalyLogWindowMs = 30000
  private readonly visibilityAnomalyLogBurst = 3
  private visibilityAnomalyLogState = new Map<string, { windowStart: number; total: number; suppressed: number }>()

  constructor(
    private readonly host: MessageCursorHost,
    private readonly messageCacheService: MessageCacheService
  ) {}

  async closeMessageCursorBySession(sessionId: string): Promise<void> {
    const state = this.messageCursors.get(sessionId)
    if (!state) return
    try {
      await wcdbService.closeMessageCursor(state.cursor)
    } catch (error) {
      console.warn(`[ChatService] 关闭消息游标失败: ${sessionId}`, error)
    } finally {
      this.messageCursors.delete(sessionId)
    }
  }

  private async trimMessageCursorStates(activeSessionId: string): Promise<void> {
    if (this.messageCursors.size <= this.messageCursorSessionLimit) return
    for (const [sessionId] of this.messageCursors) {
      if (this.messageCursors.size <= this.messageCursorSessionLimit) break
      if (sessionId === activeSessionId) continue
      await this.closeMessageCursorBySession(sessionId)
    }
  }

  closeAllCursors(): void {
    for (const state of this.messageCursors.values()) {
      try {
        wcdbService.closeMessageCursor(state.cursor)
      } catch {
        // ignore
      }
    }
    this.messageCursors.clear()
  }

  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 50,
    startTime: number = 0,
    endTime: number = 0,
    ascending: boolean = false
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; nextOffset?: number; error?: string }> {
    let releaseMessageCursorMutex: (() => void) | null = null
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const requestLimit = Math.max(1, Math.floor(limit || this.messageBatchDefault))

      // 使用互斥锁保护游标状态访问
      while (this.messageCursorMutex) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      this.messageCursorMutex = true
      let mutexReleased = false
      releaseMessageCursorMutex = () => {
        if (mutexReleased) return
        this.messageCursorMutex = false
        mutexReleased = true
      }

      let state = this.messageCursors.get(sessionId)
      if (state) {
        // refresh insertion order so Map iteration approximates LRU
        this.messageCursors.delete(sessionId)
        this.messageCursors.set(sessionId, state)
      }

      // 只在以下情况重新创建游标:
      // 1. 没有游标状态
      // 2. offset 变化导致游标位置不一致
      // 3. startTime/endTime 改变（视为全新查询）
      // 4. ascending 改变
      //
      // 注意：requestLimit 允许动态变化（前端可按“越往上拉批次越大”策略请求），
      // 不应触发游标重建，否则会造成额外 reopen/skip 开销与抖动。
      const needNewCursor = !state ||
        offset !== state.fetched || // Offset mismatch -> must reset cursor
        state.startTime !== startTime ||
        state.endTime !== endTime ||
        state.ascending !== ascending

      if (needNewCursor) {
        // 关闭旧游标
        if (state) {
          try {
            await this.closeMessageCursorBySession(sessionId)
          } catch (e) {
            console.warn('[ChatService] 关闭旧游标失败:', e)
          }
        }

        // 创建新游标
        // 注意：WeFlow 数据库中的 create_time 是以秒为单位的
        const cursorBatchSize = Math.max(1, Math.floor(state?.batchSize || requestLimit || this.messageBatchDefault))
        const beginTimestamp = startTime > 10000000000 ? Math.floor(startTime / 1000) : startTime
        const endTimestamp = endTime > 10000000000 ? Math.floor(endTime / 1000) : endTime
        const cursorResult = await wcdbService.openMessageCursor(sessionId, cursorBatchSize, ascending, beginTimestamp, endTimestamp)
        if (!cursorResult.success || !cursorResult.cursor) {
          console.error('[ChatService] 打开消息游标失败:', cursorResult.error)
          return { success: false, error: cursorResult.error || '打开消息游标失败' }
        }

        state = { cursor: cursorResult.cursor, fetched: 0, batchSize: cursorBatchSize, startTime, endTime, ascending }
        this.messageCursors.set(sessionId, state)
        await this.trimMessageCursorStates(sessionId)

        // 如果需要跳过消息(offset > 0),逐批获取但不返回
        // 注意：仅在 offset === 0 时重建游标最安全；
        // 当 startTime/endTime 变化导致重建时，offset 应由前端重置为 0
        state.bufferedMessages = []
        if (offset > 0) {
          console.warn(`[ChatService] 新游标需跳过 ${offset} 条消息（startTime=${startTime}, endTime=${endTime}）`)
          let skipped = 0
          const maxSkipAttempts = Math.ceil(offset / cursorBatchSize) + 5 // 防止无限循环
          let attempts = 0
          let emptySkipBatchStreak = 0
          while (skipped < offset && attempts < maxSkipAttempts) {
            attempts++
            const skipBatch = await wcdbService.fetchMessageBatch(state.cursor)
            if (!skipBatch.success) {
              console.error('[ChatService] 跳过消息批次失败:', skipBatch.error)
              await this.closeMessageCursorBySession(sessionId)
              return { success: false, error: skipBatch.error || '跳过消息失败' }
            }
            if (!skipBatch.rows || skipBatch.rows.length === 0) {
              if (skipBatch.hasMore && emptySkipBatchStreak < 2) {
                emptySkipBatchStreak += 1
                console.warn(
                  `[ChatService] 跳过遇到空批次，继续重试: streak=${emptySkipBatchStreak}, skipped=${skipped}/${offset}`
                )
                continue
              }

              // 部分会话在“新游标 + offset 跳过”路径会出现首批空数据但实际仍有消息，
              // 回退到稳定的 direct-offset 路径避免误判到底。
              if (skipped === 0 && startTime === 0 && endTime === 0 && !ascending) {
                const fallbackResult = await this.getMessagesByOffsetStable(sessionId, offset, requestLimit)
                if (fallbackResult.success && Array.isArray(fallbackResult.messages)) {
                  await this.closeMessageCursorBySession(sessionId)
                  releaseMessageCursorMutex?.()
                  this.messageCacheService.set(sessionId, fallbackResult.messages)
                  console.warn(
                    `[ChatService] 游标跳过异常，已切换 direct-offset 兜底: session=${sessionId}, offset=${offset}, returned=${fallbackResult.messages.length}, hasMore=${fallbackResult.hasMore === true}`
                  )
                  return {
                    success: true,
                    messages: fallbackResult.messages,
                    hasMore: fallbackResult.hasMore === true,
                    nextOffset: Number.isFinite(fallbackResult.nextOffset)
                      ? Math.floor(fallbackResult.nextOffset as number)
                      : offset + fallbackResult.messages.length
                  }
                }
              }

              console.warn(`[ChatService] 跳过时数据耗尽: skipped=${skipped}/${offset}`)
              await this.closeMessageCursorBySession(sessionId)
              return { success: true, messages: [], hasMore: false, nextOffset: skipped }
            }
            emptySkipBatchStreak = 0

            const count = skipBatch.rows.length
            // Check if we overshot the offset
            if (skipped + count > offset) {
              const keepIndex = offset - skipped
              if (keepIndex < count) {
                state.bufferedMessages = skipBatch.rows.slice(keepIndex)
              }
            }

            skipped += count

            // If satisfied offset, break
            if (skipped >= offset) break;

            if (!skipBatch.hasMore) {
              console.warn(`[ChatService] 跳过后无更多数据: skipped=${skipped}/${offset}`)
              await this.closeMessageCursorBySession(sessionId)
              return { success: true, messages: [], hasMore: false, nextOffset: skipped }
            }
          }
          if (attempts >= maxSkipAttempts) {
            console.error(`[ChatService] 跳过消息超过最大尝试次数: attempts=${attempts}`)
          }
          state.fetched = offset
          this.host.chatServiceLog(`跳过完成: skipped=${skipped}, fetched=${state.fetched}, buffered=${state.bufferedMessages?.length || 0}`)
        }
      }

      // 确保 state 已初始化
      if (!state) {
        console.error('[ChatService] 游标状态未初始化')
        return { success: false, error: '游标状态未初始化' }
      }

      const collected = await this.collectVisibleMessagesFromCursor(
        sessionId,
        state.cursor,
        requestLimit,
        state.bufferedMessages as Record<string, any>[] | undefined
      )
      state.bufferedMessages = collected.bufferedRows
      if (!collected.success) {
        return { success: false, error: collected.error || '获取消息失败' }
      }

      const rawRowsConsumed = collected.rawRowsConsumed || 0
      const filtered = collected.messages || []
      const hasMore = collected.hasMore === true
      state.fetched += rawRowsConsumed
      this.messageCursors.delete(sessionId)
      this.messageCursors.set(sessionId, state)
      releaseMessageCursorMutex?.()

      this.messageCacheService.set(sessionId, filtered)
      if (offset === 0 && startTime === 0 && endTime === 0) {
        this.host.markSyntheticUnreadRead(sessionId, filtered)
      }
      this.host.chatServiceLog(
        `getMessages session=${sessionId} rawRowsConsumed=${rawRowsConsumed} visibleMessagesReturned=${filtered.length} filteredOut=${collected.filteredOut || 0} nextOffset=${state.fetched} hasMore=${hasMore}`
      )
      return { success: true, messages: filtered, hasMore, nextOffset: state.fetched }
    } catch (e) {
      console.error('ChatService: 获取消息失败:', e)
      return { success: false, error: String(e) }
    } finally {
      releaseMessageCursorMutex?.()
    }
  }

  async getCachedSessionMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      if (!sessionId) return { success: true, messages: [] }
      const entry = this.messageCacheService.get(sessionId)
      if (!entry || !Array.isArray(entry.messages)) {
        return { success: true, messages: [] }
      }
      return { success: true, messages: entry.messages.slice() }
    } catch (error) {
      console.error('ChatService: 获取缓存消息失败:', error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * 尝试从 emoticon.db / emotion.db 恢复表情包 CDN URL
   */
  async repairEmoticonFallback(msg: Message): Promise<void> {
    if (!msg.emojiMd5) return

    try {
      const dbPath = await this.findInternalEmoticonDb()
      if (!dbPath) {
        console.warn(`[ChatService] 表情包数据库未找到，无法恢复: md5=${msg.emojiMd5}`)
        return
      }

      const urlResult = await wcdbService.getEmoticonCdnUrl(dbPath, msg.emojiMd5)
      if (!urlResult.success) {
        console.warn(`[ChatService] 表情包数据库查询失败: md5=${msg.emojiMd5}, db=${dbPath}`, urlResult.error)
        return
      }
      if (urlResult.url) {
        msg.emojiCdnUrl = urlResult.url
        return
      }

      console.warn(`[ChatService] 表情包数据库未命中: md5=${msg.emojiMd5}, db=${dbPath}`)
      // 数据库未命中时，尝试从本地 emoji 缓存目录查找（转发的表情包只有 md5，无 CDN URL）
      this.findEmojiInLocalCache(msg)

    } catch (e) {
      console.error(`[ChatService] 恢复表情包失败: md5=${msg.emojiMd5}`, e)
    }
  }

  /**
   * 从本地 WeFlow emoji 缓存目录按 md5 查找文件
   */
  private findEmojiInLocalCache(msg: Message): void {
    if (!msg.emojiMd5) return
    const cacheDir = this.host.getEmojiCacheDir()
    if (!existsSync(cacheDir)) return

    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    for (const ext of extensions) {
      const filePath = join(cacheDir, `${msg.emojiMd5}${ext}`)
      if (existsSync(filePath)) {
        msg.emojiLocalPath = filePath
        // 同步写入内存缓存，避免重复查找
        emojiCache.set(msg.emojiMd5, filePath)
        return
      }
    }
  }

  /**
   * 查找 emoticon.db 路径
   */
  private async findInternalEmoticonDb(): Promise<string | null> {
    const myWxid = this.host.getConfigString('myWxid')
    const rootDbPath = this.host.getConfigString('dbPath')
    if (!myWxid || !rootDbPath) return null

    const accountDir = this.host.resolveAccountDir(rootDbPath, myWxid)
    if (!accountDir) return null

    const candidates = [
      // 1. 标准结构: root/wxid/db_storage/emoticon
      join(rootDbPath, myWxid, 'db_storage', 'emoticon', 'emoticon.db'),
      join(rootDbPath, myWxid, 'db_storage', 'emotion', 'emoticon.db'),
    ]

    for (const p of candidates) {
      if (existsSync(p)) return p
    }

    return null
  }

  private async getMessagesByOffsetStable(
    sessionId: string,
    offset: number,
    limit: number
  ): Promise<{
    success: boolean
    messages?: Message[]
    hasMore?: boolean
    nextOffset?: number
    rawRows?: number
    filteredOut?: number
    error?: string
  }> {
    const pageLimit = Math.max(1, Math.floor(limit || this.messageBatchDefault))
    const safeOffset = Math.max(0, Math.floor(offset || 0))
    const probeLimit = Math.min(500, pageLimit + 1)

    const result = await wcdbService.getMessages(sessionId, probeLimit, safeOffset)
    if (!result.success || !Array.isArray(result.messages)) {
      return { success: false, error: result.error || '获取消息失败' }
    }

    const rawRows = result.messages as Record<string, any>[]
    const hasMore = rawRows.length > pageLimit
    const selectedRows = hasMore ? rawRows.slice(0, pageLimit) : rawRows
    const mapped = mapRowsToMessages(selectedRows, sessionId, String(this.host.getMyWxidCleaned() || '').trim())
    const visible = mapped.filter((msg) => this.isMessageVisibleForSession(sessionId, msg))
    const outputMessages = (visible.length === 0 && mapped.length > 0)
      ? mapped
      : visible
    if (visible.length === 0 && mapped.length > 0) {
      console.warn(`[ChatService] getMessagesByOffsetStable 可见性过滤回退: session=${sessionId} mapped=${mapped.length}`)
    }
    const normalized = normalizeMessageOrder(outputMessages)
    if (normalized.length > 0) {
      await this.repairEmojiMessages(normalized)
      await this.host.resolveQuotedMessages(normalized, sessionId)
    }

    return {
      success: true,
      messages: normalized,
      hasMore,
      nextOffset: safeOffset + selectedRows.length,
      rawRows: selectedRows.length,
      filteredOut: Math.max(0, mapped.length - visible.length)
    }
  }


  async getLatestMessages(sessionId: string, limit: number = this.messageBatchDefault): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; nextOffset?: number; error?: string }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      // 聊天页首屏优先走稳定路径：固定 offset=0 的 direct-offset 读取。
      const stableResult = await this.getMessagesByOffsetStable(sessionId, 0, limit)
      if (!stableResult.success || !Array.isArray(stableResult.messages)) {
        return { success: false, error: stableResult.error || '获取最新消息失败' }
      }

      this.host.chatServiceLog(
        `getLatestMessages(stable) session=${sessionId} rawRows=${stableResult.rawRows || 0} visibleMessagesReturned=${stableResult.messages.length} filteredOut=${stableResult.filteredOut || 0} nextOffset=${stableResult.nextOffset || 0} hasMore=${stableResult.hasMore === true}`
      )
      return {
        success: true,
        messages: stableResult.messages,
        hasMore: stableResult.hasMore === true,
        nextOffset: Number.isFinite(stableResult.nextOffset)
          ? Math.floor(stableResult.nextOffset as number)
          : stableResult.messages.length
      }
    } catch (e) {
      console.error('ChatService: 获取最新消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getNewMessages(sessionId: string, minTime: number, limit: number = this.messageBatchDefault): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const res = await wcdbService.getNewMessages(sessionId, minTime, limit)
      if (!res.success || !res.messages) {
        return { success: false, error: res.error || '获取新消息失败' }
      }

      // 转换为 Message 对象
      const messages = mapRowsToMessages(res.messages as Record<string, any>[], sessionId, String(this.host.getMyWxidCleaned() || '').trim())
      const normalized = normalizeMessageOrder(messages)

      // 并发检查并修复缺失 CDN URL 的表情包
      const fixPromises: Promise<void>[] = []
      for (const msg of normalized) {
        if (msg.localType === 47 && !msg.emojiCdnUrl && msg.emojiMd5) {
          fixPromises.push(this.repairEmoticonFallback(msg))
        }
      }
      if (fixPromises.length > 0) {
        await Promise.allSettled(fixPromises)
      }

      return { success: true, messages: normalized }
    } catch (e) {
      console.error('ChatService: 获取增量消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private logVisibilityAnomaly(sessionId: string, msg: Message): void {
    const key = String(sessionId || '').trim() || '__unknown__'
    const now = Date.now()
    let state = this.visibilityAnomalyLogState.get(key)
    if (!state || (now - state.windowStart) > this.visibilityAnomalyLogWindowMs) {
      if (state && state.suppressed > 0) {
        console.warn(
          `[ChatService] 会话可见性异常日志已抑制: sessionId=${key}, suppressed=${state.suppressed}, windowMs=${this.visibilityAnomalyLogWindowMs}`
        )
      }
      state = { windowStart: now, total: 0, suppressed: 0 }
      this.visibilityAnomalyLogState.set(key, state)
      if (this.visibilityAnomalyLogState.size > 256) {
        const oldest = this.visibilityAnomalyLogState.keys().next()
        if (!oldest.done) {
          this.visibilityAnomalyLogState.delete(oldest.value)
        }
      }
    }

    state.total += 1
    if (state.total <= this.visibilityAnomalyLogBurst) {
      console.warn(`[ChatService] 检测到异常消息: sessionId=${sessionId}, senderUsername=${msg.senderUsername}, localId=${msg.localId}`)
      return
    }

    state.suppressed += 1
  }

  private isMessageVisibleForSession(sessionId: string, msg: Message): boolean {
    const isGroupChat = sessionId.includes('@chatroom')
    if (isGroupChat) {
      return true
    }
    if (!msg.senderUsername || msg.senderUsername === sessionId) {
      return true
    }
    if (msg.isSend === 1) {
      return true
    }
    this.logVisibilityAnomaly(sessionId, msg)
    return false
  }

  private async repairEmojiMessages(messages: Message[]): Promise<void> {
    const fixPromises: Promise<void>[] = []
    for (const msg of messages) {
      if (msg.localType === 47 && !msg.emojiCdnUrl && msg.emojiMd5) {
        fixPromises.push(this.repairEmoticonFallback(msg))
      }
    }
    if (fixPromises.length > 0) {
      await Promise.allSettled(fixPromises)
    }
  }

  private async collectVisibleMessagesFromCursor(
    sessionId: string,
    cursor: number,
    limit: number,
    initialRows: Record<string, any>[] = []
  ): Promise<{
    success: boolean
    messages?: Message[]
    hasMore?: boolean
    error?: string
    rawRowsConsumed?: number
    filteredOut?: number
    bufferedRows?: Record<string, any>[]
  }> {
    const visibleMessages: Message[] = []
    const filteredCandidates: Message[] = []
    let queuedRows = Array.isArray(initialRows) ? initialRows.slice() : []
    let rawRowsConsumed = 0
    let filteredOut = 0
    let cursorMayHaveMore = queuedRows.length > 0
    let emptyBatchStreak = 0

    while (visibleMessages.length < limit) {
      if (queuedRows.length === 0) {
        const batch = await wcdbService.fetchMessageBatch(cursor)
        if (!batch.success) {
          console.error('[ChatService] 获取消息批次失败:', batch.error)
          if (visibleMessages.length === 0) {
            return { success: false, error: batch.error || '获取消息失败' }
          }
          cursorMayHaveMore = false
          break
        }

        const batchRows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        cursorMayHaveMore = batch.hasMore === true
        if (batchRows.length === 0) {
          if (cursorMayHaveMore && emptyBatchStreak < 2) {
            emptyBatchStreak += 1
            continue
          }
          break
        }
        emptyBatchStreak = 0
        queuedRows = batchRows
      }

      const rowsToProcess = queuedRows
      queuedRows = []
      const mappedMessages = mapRowsToMessages(rowsToProcess, sessionId, String(this.host.getMyWxidCleaned() || '').trim())
      for (let index = 0; index < mappedMessages.length; index += 1) {
        const msg = mappedMessages[index]
        rawRowsConsumed += 1
        if (this.isMessageVisibleForSession(sessionId, msg)) {
          visibleMessages.push(msg)
          if (visibleMessages.length >= limit) {
            if (index + 1 < rowsToProcess.length) {
              queuedRows = rowsToProcess.slice(index + 1)
            }
            break
          }
        } else {
          filteredOut += 1
          if (visibleMessages.length === 0 && filteredCandidates.length < limit) {
            filteredCandidates.push(msg)
          }
        }
      }

      if (visibleMessages.length >= limit) {
        break
      }

      if (!cursorMayHaveMore) {
        break
      }
    }

    if (filteredOut > 0) {
      console.warn(`[ChatService] 过滤了 ${filteredOut} 条异常消息`)
    }

    let outputMessages = visibleMessages
    if (outputMessages.length === 0 && filteredCandidates.length > 0) {
      // 回退策略：某些会话 sender_username 与 sessionId 可能不一致，避免整批被误过滤为 0 条。
      outputMessages = filteredCandidates
      console.warn(
        `[ChatService] 会话可见性过滤触发回退: session=${sessionId} fallbackCount=${filteredCandidates.length}`
      )
    }

    const normalized = normalizeMessageOrder(outputMessages)
    if (normalized.length > 0) {
      await this.repairEmojiMessages(normalized)
    }
    return {
      success: true,
      messages: normalized,
      hasMore: queuedRows.length > 0 || cursorMayHaveMore,
      rawRowsConsumed,
      filteredOut,
      bufferedRows: queuedRows.length > 0 ? queuedRows : undefined
    }
  }

}
