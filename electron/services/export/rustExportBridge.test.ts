import { describe, expect, it } from 'vitest'
import {
  parseRustExportEventLine,
  resolveRustExporterExecutableName
} from './rustExportBridge'

describe('rust export bridge protocol helpers', () => {
  it('parses known NDJSON events', () => {
    expect(parseRustExportEventLine('{"type":"createdFile","path":"C:/tmp/a.txt"}')).toEqual({
      type: 'createdFile',
      path: 'C:/tmp/a.txt'
    })
    expect(parseRustExportEventLine('{"type":"result","success":true,"successCount":1,"failCount":0}')).toEqual({
      type: 'result',
      success: true,
      successCount: 1,
      failCount: 0
    })
  })

  it('rejects invalid and unknown event lines with a readable error', () => {
    expect(() => parseRustExportEventLine('not-json')).toThrow(/Invalid Rust exporter event/)
    expect(() => parseRustExportEventLine('{"type":"surprise"}')).toThrow(/Unknown Rust exporter event/)
  })

  it('uses platform executable naming without leaking request fields into args', () => {
    expect(resolveRustExporterExecutableName('win32')).toBe('weflow-exporter.exe')
    expect(resolveRustExporterExecutableName('linux')).toBe('weflow-exporter')
  })
})
