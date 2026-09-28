import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { ConfigService } from './config'

/**
 * 密钥获取（数据库密钥 / 图片密钥）完全外包给用户自备的第三方可执行程序（keyProviderPath），
 * 不再内置任何原生内存扫描或来源校验逻辑。
 *
 * 协议：以一行 JSON 写入子进程 stdin 描述请求；子进程通过 stdout 按行输出 NDJSON：
 *   {"type":"progress","message":"...","level":0}  // 可多次，转发给 onStatus
 *   {"type":"result","success":true,...}            // 恰好一次，作为最终结果
 * 找不到/未配置可执行文件时，直接返回 {success:false, error:'未配置...'}，不做任何来源校验。
 */

type DbKeyResult = { success: boolean; key?: string; accountId?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }

const NOT_CONFIGURED_ERROR = '未配置外部密钥获取实现，请在设置中指定可执行文件路径'

type ProviderRequest =
  | { action: 'get_db_key'; dbPath?: string; accountId?: string; internalDbKeyHex?: string }
  | { action: 'get_image_key'; accountDir?: string; accountId?: string }
  | { action: 'scan_image_key_memory'; accountDir?: string }

export class KeyProviderService {
  private configService = new ConfigService()

  private getProviderPath(): string | null {
    const configured = String(this.configService.get('keyProviderPath') || '').trim()
    return configured && existsSync(configured) ? configured : null
  }

  private invoke<T extends { success: boolean; error?: string }>(
    request: ProviderRequest,
    onStatus?: (message: string, level: number) => void,
    timeoutMs = 120_000
  ): Promise<T> {
    const providerPath = this.getProviderPath()
    if (!providerPath) {
      return Promise.resolve({ success: false, error: NOT_CONFIGURED_ERROR } as T)
    }

    return new Promise<T>((resolve) => {
      let settled = false
      let stdoutBuf = ''
      let stderrBuf = ''

      const child = spawn(providerPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

      const timer = setTimeout(() => {
        if (settled) return
        finish({ success: false, error: '外部密钥获取工具执行超时' } as T)
        try { child.kill() } catch { /* ignore */ }
      }, timeoutMs)

      const finish = (result: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuf += chunk
        let nl: number
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim()
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (!line) continue
          let parsed: any
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          if (parsed?.type === 'progress') {
            onStatus?.(String(parsed.message || ''), Number(parsed.level ?? 0))
          } else if (parsed?.type === 'result') {
            const { type: _type, ...rest } = parsed
            finish(rest as T)
          }
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => { stderrBuf += chunk })

      child.on('error', (error) => {
        finish({ success: false, error: `外部密钥获取工具启动失败: ${String(error)}` } as T)
      })
      child.on('close', (code) => {
        if (settled) return
        if (code === 0) {
          finish({ success: false, error: '外部密钥获取工具未返回结果' } as T)
        } else {
          finish({ success: false, error: `外部密钥获取工具退出(code=${code})${stderrBuf ? `: ${stderrBuf.slice(0, 500)}` : ''}` } as T)
        }
      })

      try {
        child.stdin?.end(`${JSON.stringify(request)}\n`)
      } catch (error) {
        finish({ success: false, error: `写入外部密钥获取工具输入失败: ${String(error)}` } as T)
      }
    })
  }

  async autoGetDbKey(
    timeoutMs = 60_000,
    onStatus?: (message: string, level: number) => void,
    dbPath?: string,
    accountId?: string,
    internalDbKeyHex?: string
  ): Promise<DbKeyResult> {
    return this.invoke<DbKeyResult>(
      { action: 'get_db_key', dbPath, accountId, internalDbKeyHex },
      onStatus,
      Math.max(timeoutMs, 1000)
    )
  }

  async autoGetImageKey(
    manualDir?: string,
    onStatus?: (message: string) => void,
    accountId?: string
  ): Promise<ImageKeyResult> {
    return this.invoke<ImageKeyResult>({ action: 'get_image_key', accountDir: manualDir, accountId }, onStatus)
  }

  async autoGetImageKeyByMemoryScan(
    userDir: string,
    onStatus?: (message: string) => void
  ): Promise<ImageKeyResult> {
    return this.invoke<ImageKeyResult>({ action: 'scan_image_key_memory', accountDir: userDir }, onStatus)
  }
}
