import { describe, expect, it } from 'vitest'
import { createMessageStream } from './messageStream'

describe('message stream', () => {
  it('streams normalized rows across batches and closes the cursor', async () => {
    const closed: number[] = []
    const source = {
      openMessageCursorLite: async () => ({ success: true, cursor: 42 }),
      openMessageCursor: async () => ({ success: true, cursor: 99 }),
      fetchMessageBatch: async (cursor: number) => {
        expect(cursor).toBe(42)
        const calls = closed.length
        if (calls === 0) {
          closed.push(-1)
          return {
            success: true,
            rows: [
              { local_id: 1, create_time: 10, local_type: 1, message_content: 'old', is_send: 0, sender_username: 'a' },
              { local_id: 2, create_time: 20, local_type: 1, message_content: 'hello', is_send: 1, sender_username: 'ignored' }
            ],
            hasMore: true
          }
        }
        return {
          success: true,
          rows: [
            { local_id: 3, create_time: 30, local_type: 1, message_content: 'world', is_send: 0, sender_username: 'b' }
          ],
          hasMore: false
        }
      },
      closeMessageCursor: async (cursor: number) => {
        closed.push(cursor)
      }
    }

    const rows = []
    for await (const row of createMessageStream({
      source,
      sessionId: 'room',
      cleanedMyWxid: 'me',
      dateRange: { start: 15, end: 35 },
      batchSize: 2,
      useLiteCursor: true,
      decodeContent: (row) => String(row.message_content || '')
    })) {
      rows.push(row)
    }

    expect(rows).toEqual([
      { localId: 2, serverId: 0, createTime: 20, localType: 1, content: 'hello', senderUsername: 'me', isSend: true },
      { localId: 3, serverId: 0, createTime: 30, localType: 1, content: 'world', senderUsername: 'b', isSend: false }
    ])
    expect(closed).toContain(42)
  })

  it('throws when cancellation is requested during streaming', async () => {
    const source = {
      openMessageCursorLite: async () => ({ success: true, cursor: 7 }),
      openMessageCursor: async () => ({ success: true, cursor: 7 }),
      fetchMessageBatch: async () => ({ success: true, rows: [{ create_time: 1, message_content: 'x' }], hasMore: true }),
      closeMessageCursor: async () => {}
    }
    let shouldStop = false
    const iterator = createMessageStream({
      source,
      sessionId: 's',
      cleanedMyWxid: 'me',
      decodeContent: () => 'x',
      control: { shouldStop: () => shouldStop }
    })[Symbol.asyncIterator]()

    await iterator.next()
    shouldStop = true
    await expect(iterator.next()).rejects.toThrow(/导出任务已停止/)
  })

  it('marks pause requests with the shared pause code', async () => {
    const source = {
      openMessageCursorLite: async () => ({ success: true, cursor: 7 }),
      openMessageCursor: async () => ({ success: true, cursor: 7 }),
      fetchMessageBatch: async () => ({ success: true, rows: [{ create_time: 1, message_content: 'x' }], hasMore: false }),
      closeMessageCursor: async () => {}
    }

    const iterator = createMessageStream({
      source,
      sessionId: 's',
      cleanedMyWxid: 'me',
      decodeContent: () => 'x',
      control: { shouldPause: () => true }
    })[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'WEFLOW_EXPORT_PAUSE_REQUESTED'
    })
  })
})
