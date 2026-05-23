export type ExportEngine = 'auto' | 'typescript' | 'rust'

export type ExportFormat =
  | 'chatlab'
  | 'chatlab-jsonl'
  | 'json'
  | 'arkme-json'
  | 'html'
  | 'txt'
  | 'excel'
  | 'weclone'
  | 'sql'

export interface ExportEngineOptions {
  format: ExportFormat | string
  engine?: ExportEngine
  contentType?: 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file' | string
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportFiles?: boolean
  exportVoiceAsText?: boolean
}

const RUST_SUPPORTED_FORMATS = new Set<ExportFormat>([
  'json',
  'txt',
  'html',
  'weclone',
  'chatlab-jsonl'
])

const TYPESCRIPT_STREAMING_SUPPORTED_FORMATS = new Set<ExportFormat>([
  'txt',
  'html',
  'chatlab-jsonl'
])

export type ResolvedExportEngine = Exclude<ExportEngine, 'auto'>

export function isRustSupportedFormat(format: ExportFormat | string): boolean {
  return RUST_SUPPORTED_FORMATS.has(format)
}

export function isTypeScriptStreamingSupportedFormat(format: ExportFormat | string): boolean {
  return TYPESCRIPT_STREAMING_SUPPORTED_FORMATS.has(format)
}

export function isTextOnlyExport(options: ExportEngineOptions): boolean {
  if (options.contentType && options.contentType !== 'text') return false
  if (options.exportMedia === true) return false
  if (options.exportAvatars === true) return false
  if (options.exportImages === true) return false
  if (options.exportVoices === true) return false
  if (options.exportVideos === true) return false
  if (options.exportEmojis === true) return false
  if (options.exportFiles === true) return false
  if (options.exportVoiceAsText === true) return false
  return true
}

export function canUseRustExportEngine(options: ExportEngineOptions): boolean {
  return isRustSupportedFormat(options.format) && isTextOnlyExport(options)
}

export function canUseTypeScriptStreamingEngine(options: ExportEngineOptions): boolean {
  return isTypeScriptStreamingSupportedFormat(options.format) && isTextOnlyExport(options)
}

export function getRustExportDisabledReason(options: ExportEngineOptions): string | null {
  if (!isRustSupportedFormat(options.format)) return `格式 ${options.format} 暂不支持 Rust`
  if (options.contentType && options.contentType !== 'text') return `内容类型 ${options.contentType} 不是纯文本`
  if (options.exportMedia === true) return '媒体导出已开启'
  if (options.exportAvatars === true) return '头像导出已开启'
  if (options.exportImages === true) return '图片导出已开启'
  if (options.exportVoices === true) return '语音导出已开启'
  if (options.exportVideos === true) return '视频导出已开启'
  if (options.exportEmojis === true) return '表情导出已开启'
  if (options.exportFiles === true) return '文件导出已开启'
  if (options.exportVoiceAsText === true) return '语音转文字已开启'
  return null
}

export function chooseExportEngine(options: ExportEngineOptions): ResolvedExportEngine {
  if (options.engine === 'rust') return 'rust'
  if (options.engine === 'typescript') return 'typescript'
  return canUseRustExportEngine(options) ? 'rust' : 'typescript'
}
