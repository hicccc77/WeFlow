import * as path from 'path'

export type RustExportEvent =
  | { type: 'progress'; data?: Record<string, unknown>; [key: string]: unknown }
  | { type: 'createdFile'; path: string }
  | { type: 'createdDir'; path: string }
  | { type: 'result'; success: boolean; successCount?: number; failCount?: number; [key: string]: unknown }
  | { type: 'error'; error: string }

export interface RustExporterPathConfig {
  resourcesPath: string
  platform?: NodeJS.Platform
  arch?: string
  executablePath?: string
}

export function resolveRustExporterExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'weflow-exporter.exe' : 'weflow-exporter'
}

export function resolveRustExporterPlatformDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'macos'
  return platform
}

export function resolveRustExporterArchDir(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === 'darwin') return 'universal'
  return arch
}

export function resolveRustExporterPath(config: RustExporterPathConfig): string {
  if (config.executablePath) return config.executablePath
  return path.join(
    config.resourcesPath,
    'exporter',
    resolveRustExporterPlatformDir(config.platform),
    resolveRustExporterArchDir(config.platform, config.arch),
    resolveRustExporterExecutableName(config.platform)
  )
}

export function parseRustExportEventLine(line: string): RustExportEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(`Invalid Rust exporter event: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid Rust exporter event: expected object')
  }

  const event = parsed as Record<string, unknown>
  const type = String(event.type || '')
  if (type === 'progress') return event as RustExportEvent
  if (type === 'createdFile') {
    const filePath = String(event.path || '').trim()
    if (!filePath) throw new Error('Invalid Rust exporter event: createdFile.path is required')
    return { type, path: filePath }
  }
  if (type === 'createdDir') {
    const dirPath = String(event.path || '').trim()
    if (!dirPath) throw new Error('Invalid Rust exporter event: createdDir.path is required')
    return { type, path: dirPath }
  }
  if (type === 'result') return event as RustExportEvent
  if (type === 'error') {
    return { type, error: String(event.error || 'Rust exporter failed') }
  }
  throw new Error(`Unknown Rust exporter event: ${type || '<missing>'}`)
}
