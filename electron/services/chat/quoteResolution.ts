import { wcdbService } from '../wcdbService'
import { decodeMessageContent, sanitizeQuotedContent } from './messageParsing'
import type { Message } from './types'

export type QuoteDebugLog = (message: string, meta?: unknown) => void

export async function resolveQuotedMessages(
  messages: Message[],
  sessionId: string,
  debugLog?: QuoteDebugLog
): Promise<void> {
  const log = debugLog || (() => {})
  log('resolveQuotedMessages - 开始解析,消息数量:', messages.length)
  const svridsToResolve: Array<{ msg: Message; svrid: string }> = []

  for (const msg of messages) {
    if (msg.quotedContent && msg.quotedContent.startsWith('__SVRID__')) {
      const match = msg.quotedContent.match(/__SVRID__(.+?)__/)
      if (match) {
        log('resolveQuotedMessages - 找到需要解析的svrid:', match[1])
        svridsToResolve.push({ msg, svrid: match[1] })
      }
    }
  }

  log('resolveQuotedMessages - 需要解析的数量:', svridsToResolve.length)
  if (svridsToResolve.length === 0) return

  const results = await Promise.allSettled(
    svridsToResolve.map(({ svrid }) => {
      log('resolveQuotedMessages - 查询svrid:', { svrid, sessionId })
      return wcdbService.getMessageByServerId(sessionId, svrid)
    })
  )

  log('resolveQuotedMessages - 查询结果数量:', results.length)

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const { msg, svrid } = svridsToResolve[i]

    log('resolveQuotedMessages - 处理结果', {
      index: i,
      status: result.status,
      success: result.status === 'fulfilled' ? result.value.success : false,
      hasRow: result.status === 'fulfilled' && result.value.row ? true : false,
      error: result.status === 'fulfilled' ? result.value.error : undefined,
      svrid
    })

    if (result.status === 'fulfilled' && result.value.success && result.value.row) {
      const localType = parseInt(result.value.row.local_type || '0', 10)
      const rawMessageContent = result.value.row.message_content
      const rawCompressContent = result.value.row.compress_content

      log('resolveQuotedMessages - 原始数据:', {
        hasMessageContent: !!rawMessageContent,
        hasCompressContent: !!rawCompressContent,
        messageContentType: typeof rawMessageContent,
        messageContentLength: rawMessageContent ? rawMessageContent.length : 0
      })

      const content = decodeMessageContent(rawMessageContent, rawCompressContent)

      log('resolveQuotedMessages - 解码后:', {
        localType,
        contentLength: content.length,
        contentPreview: content.substring(0, 50)
      })

      if (localType === 1) {
        msg.quotedContent = sanitizeQuotedContent(content)
      } else if (localType === 3) {
        msg.quotedContent = '[图片]'
      } else if (localType === 34) {
        msg.quotedContent = '[语音]'
      } else if (localType === 43) {
        msg.quotedContent = '[视频]'
      } else if (localType === 47) {
        msg.quotedContent = '[动画表情]'
      } else if (localType === 49) {
        msg.quotedContent = '[链接]'
      } else {
        msg.quotedContent = '[消息]'
      }
      log('resolveQuotedMessages - 更新后的quotedContent:', msg.quotedContent)
    } else {
      msg.quotedContent = '[引用消息]'
      log('resolveQuotedMessages - 查询失败,使用占位符')
    }
  }
  log('resolveQuotedMessages - 完成')
}
