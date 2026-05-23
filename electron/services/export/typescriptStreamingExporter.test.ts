import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { canUseTypeScriptStreamingExport, exportSessionsWithTypeScriptStreaming } from './typescriptStreamingExporter'

const cleanupPaths: string[] = []

afterEach(() => {
  for (const item of cleanupPaths.splice(0).sort((a, b) => b.length - a.length)) {
    try { fs.rmSync(item, { recursive: true, force: true }) } catch {}
  }
})

describe('typescript streaming exporter', () => {
  it('gates streaming to text-only supported formats', () => {
    expect(canUseTypeScriptStreamingExport({ format: 'txt' })).toBe(true)
    expect(canUseTypeScriptStreamingExport({ format: 'html', contentType: 'text' })).toBe(true)
    expect(canUseTypeScriptStreamingExport({ format: 'weclone' })).toBe(false)
    expect(canUseTypeScriptStreamingExport({ format: 'txt', exportMedia: true })).toBe(false)
  })

  it('exports a session through cursor batches and records created paths', async () => {
    const outputDir = path.join(os.tmpdir(), `weflow-ts-stream-${Date.now()}-${process.pid}`)
    cleanupPaths.push(outputDir)
    const createdFiles: string[] = []
    const createdDirs: string[] = []
    let fetchCount = 0
    let closedCursor = 0
    const source = {
      open: async () => true,
      getDisplayNames: async (usernames: string[]) => ({
        success: true,
        map: Object.fromEntries(usernames.map(username => [username, username === 'room' ? '测试会话' : `name-${username}`]))
      }),
      openMessageCursor: async () => ({ success: true, cursor: 1 }),
      openMessageCursorLite: async () => ({ success: true, cursor: 1 }),
      fetchMessageBatch: async () => {
        fetchCount++
        if (fetchCount === 1) {
          return {
            success: true,
            rows: [
              { local_id: 1, server_id: 11, create_time: 1, local_type: 1, message_content: 'hello', is_send: 1 },
              { local_id: 2, server_id: 12, create_time: 2, local_type: 1, message_content: 'world', is_send: 0, sender_username: 'friend' }
            ],
            hasMore: false
          }
        }
        return { success: true, rows: [], hasMore: false }
      },
      closeMessageCursor: async (cursor: number) => {
        closedCursor = cursor
      }
    }

    const result = await exportSessionsWithTypeScriptStreaming({
      source,
      sessionIds: ['room'],
      outputDir,
      options: { format: 'txt' },
      accountDir: 'account',
      decryptKey: 'key',
      cleanedMyWxid: 'me',
      control: {
        recordCreatedFile: filePath => createdFiles.push(filePath),
        recordCreatedDir: dirPath => createdDirs.push(dirPath)
      }
    })

    expect(result.success).toBe(true)
    expect(fetchCount).toBe(1)
    expect(closedCursor).toBe(1)
    expect(createdDirs).toEqual([outputDir])
    expect(createdFiles.length).toBe(1)
    expect(fs.readFileSync(createdFiles[0], 'utf-8')).toContain('hello')
    expect(fs.readFileSync(createdFiles[0], 'utf-8')).toContain('world')
  })

  it('returns a resumable paused result instead of failing the session', async () => {
    const outputDir = path.join(os.tmpdir(), `weflow-ts-stream-paused-${Date.now()}-${process.pid}`)
    cleanupPaths.push(outputDir)
    const source = {
      open: async () => true,
      getDisplayNames: async (usernames: string[]) => ({
        success: true,
        map: Object.fromEntries(usernames.map(username => [username, username]))
      }),
      openMessageCursor: async () => ({ success: true, cursor: 1 }),
      openMessageCursorLite: async () => ({ success: true, cursor: 1 }),
      fetchMessageBatch: async () => ({ success: true, rows: [], hasMore: false }),
      closeMessageCursor: async () => {}
    }

    const result = await exportSessionsWithTypeScriptStreaming({
      source,
      sessionIds: ['room', 'next'],
      outputDir,
      options: { format: 'txt' },
      accountDir: 'account',
      decryptKey: 'key',
      cleanedMyWxid: 'me',
      control: {
        shouldPause: () => true
      }
    })

    expect(result.success).toBe(true)
    expect(result.paused).toBe(true)
    expect(result.failedSessionIds).toEqual([])
    expect(result.pendingSessionIds).toEqual(['room', 'next'])
  })
})
