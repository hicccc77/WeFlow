import { spawn } from 'child_process'
import { chmodSync, existsSync } from 'fs'

export interface WeliveRawExportManifest {
  path: string
  rows: number
  bytes: number
  images_failed?: number
  voices_failed?: number
  videos_failed?: number
  emojis_failed?: number
  files_failed?: number
}

export type WeliveExportEvent =
  | { type: 'ready'; total?: number; output_dir?: string; exports_dir?: string; media_dir?: string }
  | {
      type: 'progress'
      phase?: string
      current?: number
      total?: number
      session_id?: string
      label?: string
      exported_messages?: number
      estimated_total_messages?: number
      phase_progress?: number
      phase_total?: number
    }
  | { type: 'created_file'; path?: string; session_id?: string }
  | { type: 'created_dir'; path?: string }
  | { type: 'session_error'; session_id?: string; error?: string }
  | {
      type: 'result'
      success?: boolean
      success_count?: number
      fail_count?: number
      failed_sessions?: Array<{ session_id?: string; error?: string }>
      session_output_paths?: Record<string, string>
      raw_session_output_paths?: Record<string, string>
      raw_export_manifests?: Record<string, WeliveRawExportManifest>
      elapsed_ms?: number
    }
  | { type: string; [key: string]: unknown }

export interface WeliveExportRequest {
  account: {
    sessionDb: string
    dbKey: string
    myAccountId?: string
    accountDir?: string
    imageXorKey?: string | number
    imageAesKey?: string
  }
  sessionIds: string[]
  outputDir: string
  exportsDir?: string
  mediaDir?: string
  mediaTypes?: Array<'image' | 'voice' | 'video' | 'emoji' | 'file'>
  emojiCacheDir?: string
  formattedDir?: string
  format?: string
  preferredOutputPath?: string
  parseContent?: boolean
  compactRaw?: boolean
  preserveMessageContent?: boolean
  sanitize?: boolean
  batchSize?: number
  ascending?: boolean
  options?: Record<string, unknown>
}

export interface RunWeliveExportOptions {
  request: WeliveExportRequest
  resourcesPath: string
  appPath?: string
  welivePath?: string
  weliveArgsPrefix?: string[]
  signal?: AbortSignal
  onEvent?: (event: WeliveExportEvent) => void
}

export interface WeliveExportResult {
  success: boolean
  successCount: number
  failCount: number
  failedSessionIds: string[]
  failedSessionErrors: Record<string, string>
  sessionOutputPaths: Record<string, string>
  rawSessionOutputPaths: Record<string, string>
  rawExportManifests: Record<string, WeliveRawExportManifest>
  rawResult?: WeliveExportEvent
  stderr?: string
  error?: string
  diagnostics?: Record<string, unknown>
  stopped?: boolean
}

const formatExitCode = (code: number | null, signal: NodeJS.Signals | null | undefined) => {
  if (code === null) return signal ? `signal:${signal}` : 'unknown'
  const unsigned = code >>> 0
  const signed = unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned
  const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`
  return signed === code
    ? `${code} (${hex})`
    : `${code} (${hex}, signed ${signed})`
}

const summarizeEvent = (event?: WeliveExportEvent) => {
  if (!event) return undefined
  const summary: Record<string, unknown> = { type: event.type }
  for (const key of ['phase', 'label', 'session_id', 'current', 'total', 'exported_messages', 'estimated_total_messages']) {
    if ((event as any)[key] !== undefined) summary[key] = (event as any)[key]
  }
  return summary
}

const formatDiagnostics = (diagnostics: Record<string, unknown>) => {
  const parts = [
    diagnostics.exit ? `exit=${diagnostics.exit}` : '',
    diagnostics.exe ? `exe=${diagnostics.exe}` : '',
    diagnostics.platform ? `platform=${diagnostics.platform}` : '',
    diagnostics.arch ? `arch=${diagnostics.arch}` : '',
    diagnostics.lastEvent ? `lastEvent=${JSON.stringify(diagnostics.lastEvent)}` : ''
  ].filter(Boolean)
  return parts.length > 0 ? `[welive-diagnostics] ${parts.join(' ')}` : ''
}

/**
 * WeLive 是用户自备的外部批量导出引擎（第三方可插拔实现），不再随应用内置查找。
 * 仅认调用方显式传入的 welivePath。
 */
export function resolveWeliveExecutable(_resourcesPath: string, _appPath?: string): string | null {
  return null
}

export async function runWeliveExport(options: RunWeliveExportOptions): Promise<WeliveExportResult> {
  const exe = options.welivePath && existsSync(options.welivePath) ? options.welivePath : null
  if (!exe) {
    return {
      success: false,
      successCount: 0,
      failCount: options.request.sessionIds.length,
      failedSessionIds: options.request.sessionIds,
      failedSessionErrors: Object.fromEntries(options.request.sessionIds.map((id) => [id, '未配置 WeLive 导出引擎，请在设置中指定可执行文件路径'])),
      sessionOutputPaths: {},
      rawSessionOutputPaths: {},
      rawExportManifests: {},
      error: '未配置 WeLive 导出引擎，请在设置中指定可执行文件路径'
    }
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(exe, 0o755)
    } catch {
      // Best-effort; spawn will report a clearer EACCES if chmod is not allowed.
    }
  }

  return await new Promise<WeliveExportResult>((resolve) => {
    const child = spawn(exe, [...(options.weliveArgsPrefix || []), 'weflow-export'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdoutBuffer = ''
    let stderr = ''
    let settled = false
    let aborted = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let rawResult: WeliveExportEvent | undefined
    let lastEvent: WeliveExportEvent | undefined
    const eventTrail: Array<Record<string, unknown>> = []
    const failedSessionErrors: Record<string, string> = {}
    const sessionOutputPaths: Record<string, string> = {}
    const rawSessionOutputPaths: Record<string, string> = {}
    const rawExportManifests: Record<string, WeliveRawExportManifest> = {}

    const finish = (result: WeliveExportResult) => {
      if (settled) return
      settled = true
      if (forceKillTimer) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', abort)
      resolve({ ...result, stderr: stderr.trim() || undefined })
    }

    const abort = () => {
      if (settled || aborted) return
      aborted = true
      try {
        child.kill()
      } catch {
        // The close/error handlers below still settle the request.
      }
      forceKillTimer = setTimeout(() => {
        if (settled || child.exitCode !== null || !child.pid) return
        try {
          if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true
            })
            killer.unref()
          } else {
            process.kill(child.pid, 'SIGKILL')
          }
        } catch {
          // Process may have exited between the checks.
        }
      }, 2_000)
      forceKillTimer.unref?.()
    }

    options.signal?.addEventListener('abort', abort)

    const handleEvent = (event: WeliveExportEvent) => {
      lastEvent = event
      const eventSummary = summarizeEvent(event)
      if (eventSummary) {
        eventTrail.push(eventSummary)
        if (eventTrail.length > 8) eventTrail.shift()
      }
      options.onEvent?.(event)
      if (event.type === 'session_error') {
        const sessionId = String(event.session_id || '').trim()
        if (sessionId) failedSessionErrors[sessionId] = String(event.error || 'WeLive 会话导出失败')
      }
      if (event.type === 'created_file' && event.session_id && event.path) {
        sessionOutputPaths[String(event.session_id)] = String(event.path)
      }
      if (event.type === 'result') {
        rawResult = event
        const outputMap = event.session_output_paths && typeof event.session_output_paths === 'object'
          ? event.session_output_paths as Record<string, string>
          : {}
        const rawOutputMap = (event as any).raw_session_output_paths && typeof (event as any).raw_session_output_paths === 'object'
          ? (event as any).raw_session_output_paths as Record<string, string>
          : {}
        const manifestMap = event.raw_export_manifests && typeof event.raw_export_manifests === 'object'
          ? event.raw_export_manifests
          : {}
        for (const [sessionId, outputPath] of Object.entries(outputMap)) {
          sessionOutputPaths[sessionId] = String(outputPath)
        }
        for (const [sessionId, outputPath] of Object.entries(rawOutputMap)) {
          rawSessionOutputPaths[sessionId] = String(outputPath)
        }
        for (const [sessionId, manifest] of Object.entries(manifestMap)) {
          if (!manifest || typeof manifest !== 'object') continue
          rawExportManifests[sessionId] = {
            path: String(manifest.path || rawOutputMap[sessionId] || ''),
            rows: Number(manifest.rows),
            bytes: Number(manifest.bytes),
            images_failed: Number(manifest.images_failed || 0),
            voices_failed: Number(manifest.voices_failed || 0),
            videos_failed: Number(manifest.videos_failed || 0),
            emojis_failed: Number(manifest.emojis_failed || 0),
            files_failed: Number(manifest.files_failed || 0)
          }
        }
        if (Array.isArray(event.failed_sessions)) {
          for (const item of event.failed_sessions) {
            const sessionId = String(item?.session_id || '').trim()
            if (sessionId) failedSessionErrors[sessionId] = String(item?.error || 'WeLive 会话导出失败')
          }
        }
      }
    }

    const drainStdout = () => {
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        if (line) {
          try {
            handleEvent(JSON.parse(line) as WeliveExportEvent)
          } catch (error) {
            stderr += `\n[welive-bridge] 无法解析事件: ${line}`
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      drainStdout()
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      finish({
        success: false,
        successCount: 0,
        failCount: aborted ? 0 : options.request.sessionIds.length,
        failedSessionIds: aborted ? [] : options.request.sessionIds,
        failedSessionErrors: aborted
          ? {}
          : Object.fromEntries(options.request.sessionIds.map((id) => [id, error.message])),
        sessionOutputPaths,
        rawSessionOutputPaths,
        rawExportManifests,
        rawResult,
        error: aborted ? '用户已取消' : error.message,
        stopped: aborted,
        diagnostics: {
          exe,
          platform: process.platform,
          arch: process.arch,
          pid: child.pid,
          lastEvent: summarizeEvent(lastEvent),
          eventTrail
        }
      })
    })

    // close 在 stdout/stderr 都关闭后触发；分块导出时 result 事件更大，
    // 若在 exit 阶段结算，尾部输出尚未排空会被误判为缺少会话结果。
    child.on('close', (code, signal) => {
      drainStdout()
      const failedSessionIds = aborted ? [] : Object.keys(failedSessionErrors)
      const success = !aborted && code === 0 && rawResult?.type === 'result' && rawResult.success !== false
      const diagnostics = {
        exit: formatExitCode(code, signal),
        code,
        signal,
        exe,
        platform: process.platform,
        arch: process.arch,
        pid: child.pid,
        lastEvent: summarizeEvent(lastEvent),
        eventTrail
      }
      const diagnosticText = success ? '' : formatDiagnostics(diagnostics)
      const errorText = stderr.trim() || `WeLive 导出引擎退出码: ${formatExitCode(code, signal)}`
      finish({
        success,
        successCount: Number((rawResult as any)?.success_count ?? Object.keys(sessionOutputPaths).length),
        failCount: Number((rawResult as any)?.fail_count ?? failedSessionIds.length),
        failedSessionIds,
        failedSessionErrors,
        sessionOutputPaths,
        rawSessionOutputPaths,
        rawExportManifests,
        rawResult,
        stopped: aborted,
        diagnostics,
        error: aborted ? '用户已取消' : (success ? undefined : [errorText, diagnosticText].filter(Boolean).join('\n'))
      })
    })

    if (options.signal?.aborted) {
      abort()
    } else {
      child.stdin.end(JSON.stringify(options.request))
    }
  })
}
