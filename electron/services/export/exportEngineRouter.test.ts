import { describe, expect, it } from 'vitest'
import { chooseExportEngine, getRustExportDisabledReason, isRustSupportedFormat, isTextOnlyExport } from './exportEngineRouter'

describe('export engine routing', () => {
  it('routes auto text-only supported formats to rust', () => {
    expect(chooseExportEngine({ format: 'txt' })).toBe('rust')
    expect(chooseExportEngine({ format: 'html', contentType: 'text' })).toBe('rust')
    expect(chooseExportEngine({ format: 'json' })).toBe('rust')
    expect(chooseExportEngine({ format: 'weclone' })).toBe('rust')
    expect(chooseExportEngine({ format: 'chatlab-jsonl' })).toBe('rust')
  })

  it('routes unsupported formats and media-heavy options to typescript in auto mode', () => {
    expect(chooseExportEngine({ format: 'excel' })).toBe('typescript')
    expect(chooseExportEngine({ format: 'txt', exportMedia: true, exportImages: true })).toBe('typescript')
    expect(chooseExportEngine({ format: 'json', exportMedia: true, exportImages: true })).toBe('typescript')
    expect(chooseExportEngine({ format: 'html', exportAvatars: true })).toBe('typescript')
    expect(chooseExportEngine({ format: 'txt', exportVoiceAsText: true })).toBe('typescript')
    expect(chooseExportEngine({ format: 'txt', contentType: 'image' })).toBe('typescript')
  })

  it('honors explicit engine requests', () => {
    expect(chooseExportEngine({ format: 'excel', engine: 'rust' })).toBe('rust')
    expect(chooseExportEngine({ format: 'txt', engine: 'typescript' })).toBe('typescript')
    expect(chooseExportEngine({ format: 'txt', engine: 'auto' })).toBe('rust')
  })

  it('exposes narrow predicates for bridge fallback decisions', () => {
    expect(isRustSupportedFormat('txt')).toBe(true)
    expect(isRustSupportedFormat('json')).toBe(true)
    expect(isRustSupportedFormat('chatlab')).toBe(false)
    expect(isTextOnlyExport({ format: 'txt' })).toBe(true)
    expect(isTextOnlyExport({ format: 'txt', exportFiles: true })).toBe(false)
  })

  it('explains why rust is disabled', () => {
    expect(getRustExportDisabledReason({ format: 'chatlab' })).toContain('暂不支持 Rust')
    expect(getRustExportDisabledReason({ format: 'json', exportMedia: true })).toBe('媒体导出已开启')
    expect(getRustExportDisabledReason({ format: 'txt', exportAvatars: true })).toBe('头像导出已开启')
    expect(getRustExportDisabledReason({ format: 'txt' })).toBeNull()
  })
})
