import { app, shell } from 'electron'
import { join, basename, dirname } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import { homedir } from 'os'

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; error?: string }
const execFileAsync = promisify(execFile)

export class KeyServiceMac {
  private koffi: any = null
  private lib: any = null
  private initialized = false

  private GetDbKey: any = null
  private ListWeChatProcesses: any = null
  private libSystem: any = null
  private machTaskSelf: any = null
  private taskForPid: any = null
  private machVmRegion: any = null
  private machVmReadOverwrite: any = null
  private machPortDeallocate: any = null
  private _needsElevation = false

  private getHelperPath(): string {
    const isPackaged = app.isPackaged
    const candidates: string[] = []

    if (process.env.WX_KEY_HELPER_PATH) {
      candidates.push(process.env.WX_KEY_HELPER_PATH)
    }

    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'xkey_helper'))
      candidates.push(join(process.resourcesPath, 'xkey_helper'))
    } else {
      const cwd = process.cwd()
      candidates.push(join(cwd, 'resources', 'xkey_helper'))
      candidates.push(join(cwd, 'Xkey', 'build', 'xkey_helper'))
      candidates.push(join(app.getAppPath(), 'resources', 'xkey_helper'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    throw new Error('xkey_helper not found')
  }

  private getImageScanHelperPath(): string {
    const isPackaged = app.isPackaged
    const candidates: string[] = []

    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'image_scan_helper'))
      candidates.push(join(process.resourcesPath, 'image_scan_helper'))
    } else {
      const cwd = process.cwd()
      candidates.push(join(cwd, 'resources', 'image_scan_helper'))
      candidates.push(join(app.getAppPath(), 'resources', 'image_scan_helper'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    throw new Error('image_scan_helper not found')
  }

  private getDylibPath(): string {
    const isPackaged = app.isPackaged
    const candidates: string[] = []

    if (process.env.WX_KEY_DYLIB_PATH) {
      candidates.push(process.env.WX_KEY_DYLIB_PATH)
    }

    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'libwx_key.dylib'))
      candidates.push(join(process.resourcesPath, 'libwx_key.dylib'))
    } else {
      const cwd = process.cwd()
      candidates.push(join(cwd, 'resources', 'libwx_key.dylib'))
      candidates.push(join(app.getAppPath(), 'resources', 'libwx_key.dylib'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    throw new Error('libwx_key.dylib not found')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      this.koffi = require('koffi')
      const dylibPath = this.getDylibPath()

      if (!existsSync(dylibPath)) {
        throw new Error('libwx_key.dylib not found: ' + dylibPath)
      }

      this.lib = this.koffi.load(dylibPath)

      this.GetDbKey = this.lib.func('const char* GetDbKey()')
      this.ListWeChatProcesses = this.lib.func('const char* ListWeChatProcesses()')

      this.initialized = true
    } catch (e: any) {
      throw new Error('Failed to initialize KeyServiceMac: ' + e.message)
    }
  }

  private async checkSipStatus(): Promise<{ enabled: boolean; error?: string }> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/csrutil', ['status'])
      const enabled = stdout.toLowerCase().includes('enabled')
      return { enabled }
    } catch (e: any) {
      return { enabled: false, error: e.message }
    }
  }

  async autoGetDbKey(
    timeoutMs = 60_000,
    onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    try {
      // 检测 SIP 状态
      const sipStatus = await this.checkSipStatus()
      if (sipStatus.enabled) {
        return {
          success: false,
          error: 'SIP (系统完整性保护) 已开启，无法获取密钥。请关闭 SIP 后重试。\n\n关闭方法：\n1. Intel 芯片：重启 Mac 并按住 Command + R 进入恢复模式\n2. Apple 芯片（M 系列）：关机后长按开机（指纹）键，选择“设置（选项）”进入恢复模式\n3. 打开终端，输入: csrutil disable\n4. 重启电脑'
        }
      }

      onStatus?.('正在获取数据库密钥...', 0)
      onStatus?.('正在请求管理员授权并执行 helper...', 0)
      let parsed: { success: boolean; key?: string; code?: string; detail?: string; raw: string }
      try {
        const elevatedResult = await this.getDbKeyByHelperElevated(timeoutMs, onStatus)
        parsed = this.parseDbKeyResult(elevatedResult)
        console.log('[KeyServiceMac] GetDbKey elevated returned:', parsed.raw)
      } catch (e: any) {
        const msg = `${e?.message || e}`
        if (msg.includes('(-128)') || msg.includes('User canceled')) {
          return { success: false, error: '已取消管理员授权' }
        }
        throw e
      }

      if (!parsed.success) {
        const errorMsg = this.mapDbKeyErrorMessage(parsed.code, parsed.detail)
        onStatus?.(errorMsg, 2)
        return { success: false, error: errorMsg }
      }

      onStatus?.('密钥获取成功', 1)
      return { success: true, key: parsed.key }
    } catch (e: any) {
      console.error('[KeyServiceMac] Error:', e)
      console.error('[KeyServiceMac] Stack:', e.stack)
      onStatus?.('获取失败: ' + e.message, 2)
      return { success: false, error: e.message }
    }
  }

  private parseDbKeyResult(raw: any): { success: boolean; key?: string; code?: string; detail?: string; raw: string } {
    const text = typeof raw === 'string' ? raw : ''
    if (!text) return { success: false, code: 'UNKNOWN', raw: text }
    if (!text.startsWith('ERROR:')) return { success: true, key: text, raw: text }

    const parts = text.split(':')
    return {
      success: false,
      code: parts[1] || 'UNKNOWN',
      detail: parts.slice(2).join(':') || undefined,
      raw: text
    }
  }

  private async getDbKeyParsed(
    timeoutMs: number,
    onStatus?: (message: string, level: number) => void
  ): Promise<{ success: boolean; key?: string; code?: string; detail?: string; raw: string }> {
    const helperResult = await this.getDbKeyByHelper(timeoutMs, onStatus)
    return this.parseDbKeyResult(helperResult)
  }

  private async getWeChatPid(): Promise<number> {
    try {
      // 优先使用 pgrep -x 精确匹配进程名
      try {
        const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-x', 'WeChat'])
        const ids = stdout.split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
        if (ids.length > 0) return Math.max(...ids)
      } catch {
        // ignore and fallback
      }

      // pgrep -f 匹配完整命令行路径（打包后 pgrep -x 可能失败时的备选）
      try {
        const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-f', 'WeChat.app/Contents/MacOS/WeChat'])
        const ids = stdout.split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
        if (ids.length > 0) return Math.max(...ids)
      } catch {
        // ignore and fallback to ps
      }

      const { stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pid,comm,command'])
      const lines = stdout.split('\n').slice(1)

      const candidates: Array<{ pid: number; comm: string; command: string }> = []
      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
        if (!match) continue

        const pid = parseInt(match[1], 10)
        const comm = match[2]
        const command = match[3]

        // 打包后 command 列可能被截断或为空，同时检查 comm 列
        const pathMatch = command.includes('/Applications/WeChat.app/Contents/MacOS/WeChat') ||
                          command.includes('/Contents/MacOS/WeChat') ||
                          comm === 'WeChat'
        if (pathMatch) candidates.push({ pid, comm, command })
      }

      if (candidates.length === 0) throw new Error('WeChat process not found')

      const filtered = candidates.filter(p => {
        const cmd = p.command
        return !cmd.includes('WeChatAppEx.app/') &&
               !cmd.includes('/WeChatAppEx') &&
               !cmd.includes(' WeChatAppEx') &&
               !cmd.includes('crashpad_handler') &&
               !cmd.includes('Helper') &&
               p.comm !== 'WeChat Helper'
      })
      if (filtered.length === 0) throw new Error('No valid WeChat main process found')

      const preferredMain = filtered.filter(p =>
        p.command.includes('/Contents/MacOS/WeChat') || p.comm === 'WeChat'
      )
      const selectedPool = preferredMain.length > 0 ? preferredMain : filtered
      const selected = selectedPool.reduce((max, p) => p.pid > max.pid ? p : max)
      return selected.pid
    } catch (e: any) {
      throw new Error('Failed to get WeChat PID: ' + e.message)
    }
  }

  private async getDbKeyByHelper(
    timeoutMs: number,
    onStatus?: (message: string, level: number) => void
  ): Promise<string> {
    const helperPath = this.getHelperPath()
    const waitMs = Math.max(timeoutMs, 30_000)
    const timeoutSec = Math.ceil(waitMs / 1000) + 30
    const pid = await this.getWeChatPid()
    onStatus?.(`已找到微信进程 PID=${pid}，正在定位目标函数...`, 0)
    // 最佳努力清理同路径残留 helper（普通权限）
    try { await execFileAsync('/usr/bin/pkill', ['-f', helperPath], { timeout: 2000 }) } catch { }
    
    return await new Promise<string>((resolve, reject) => {
      // xkey_helper 参数协议：helper <pid> [timeout_ms]
      const child = spawn(helperPath, [String(pid), String(waitMs)], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let stdoutBuf = ''
      let stderrBuf = ''
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      let pidNotified = false
      let locatedNotified = false
      let hookNotified = false

      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        if (killTimer) clearTimeout(killTimer)
        fn()
      }

      const processHelperLine = (line: string) => {
        if (!line) return
        console.log('[KeyServiceMac][helper][stderr]', line)
        const pidMatch = line.match(/Selected PID=(\d+)/)
        if (pidMatch && !pidNotified) {
          pidNotified = true
          onStatus?.(`已找到微信进程 PID=${pidMatch[1]}，正在定位目标函数...`, 0)
        }
        if (!locatedNotified && (line.includes('strict hit=') || line.includes('sink matched by strict semantic signature'))) {
          locatedNotified = true
          onStatus?.('已定位到目标函数，正在安装 Hook...', 0)
        }
        if (line.includes('hook installed @')) {
          hookNotified = true
          onStatus?.('Hook 已安装，等待微信触发密钥调用...', 0)
        }
        if (line.includes('[MASTER] hex64=')) {
          onStatus?.('检测到密钥回调，正在回填...', 0)
        }
      }

      child.stdout.on('data', (chunk: Buffer | string) => {
        const data = chunk.toString()
        stdout += data
        stdoutBuf += data
        const parts = stdoutBuf.split(/\r?\n/)
        stdoutBuf = parts.pop()!
      })

      child.stderr.on('data', (chunk: Buffer | string) => {
        const data = chunk.toString()
        stderr += data
        stderrBuf += data
        const parts = stderrBuf.split(/\r?\n/)
        stderrBuf = parts.pop()!
        for (const line of parts) processHelperLine(line.trim())
      })

      child.on('error', (err) => {
        done(() => reject(err))
      })

      child.on('close', () => {
        if (stderrBuf.trim()) processHelperLine(stderrBuf.trim())

        const lines = stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
        const last = lines[lines.length - 1]
        if (!last) {
          done(() => reject(new Error(stderr.trim() || 'helper returned empty output')))
          return
        }

        let payload: any
        try {
          payload = JSON.parse(last)
        } catch {
          done(() => reject(new Error('helper returned invalid json: ' + last)))
          return
        }

        if (payload?.success === true && typeof payload?.key === 'string') {
          if (!hookNotified) {
            onStatus?.('Hook 已触发，正在回填密钥...', 0)
          }
          done(() => resolve(payload.key))
          return
        }
        if (typeof payload?.result === 'string') {
          done(() => resolve(payload.result))
          return
        }
        done(() => reject(new Error('helper json missing key/result')))
      })

      killTimer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { }
        done(() => reject(new Error(`helper timeout after ${waitMs}ms`)))
      }, waitMs + 10_000)
    })
  }

  private shellSingleQuote(text: string): string {
    return `'${String(text).replace(/'/g, `'\\''`)}'`
  }

  private async getDbKeyByHelperElevated(
    timeoutMs: number,
    onStatus?: (message: string, level: number) => void
  ): Promise<string> {
    const helperPath = this.getHelperPath()
    const waitMs = Math.max(timeoutMs, 30_000)
    const timeoutSec = Math.ceil(waitMs / 1000) + 30
    const pid = await this.getWeChatPid()
    // 用 AppleScript 的 quoted form 组装命令，避免复杂 shell 拼接导致整条失败
    // 通过 try/on error 回传详细错误，避免只看到 "Command failed"
    const scriptLines = [
      `set helperPath to ${JSON.stringify(helperPath)}`,
      `set cmd to quoted form of helperPath & " ${pid} ${waitMs}"`,
      `set timeoutSec to ${timeoutSec}`,
      'try',
      'with timeout of timeoutSec seconds',
      'set outText to do shell script (cmd & " 2>&1") with administrator privileges',
      'end timeout',
      'return "WF_OK::" & outText',
      'on error errMsg number errNum partial result pr',
      'return "WF_ERR::" & errNum & "::" & errMsg & "::" & (pr as text)',
      'end try'
    ]
    onStatus?.('已准备就绪，现在登录微信或退出登录后重新登录微信', 0)

    let stdout = ''
    try {
      const result = await execFileAsync('/usr/bin/osascript', scriptLines.flatMap(line => ['-e', line]), {
        timeout: waitMs + 20_000
      })
      stdout = result.stdout
    } catch (e: any) {
      const msg = `${e?.stderr || ''}\n${e?.stdout || ''}\n${e?.message || ''}`.trim()
      throw new Error(msg || 'elevated helper execution failed')
    }

    const lines = String(stdout).split(/\r?\n/).map(x => x.trim()).filter(Boolean)
    if (!lines.length) throw new Error('elevated helper returned empty output')
    const joined = lines.join('\n')

    if (joined.startsWith('WF_ERR::')) {
      const parts = joined.split('::')
      const errNum = parts[1] || 'unknown'
      const errMsg = parts[2] || 'unknown'
      const partial = parts.slice(3).join('::')
      throw new Error(`elevated helper failed: errNum=${errNum}, errMsg=${errMsg}, partial=${partial || '(empty)'}`)
    }
    const normalizedOutput = joined.startsWith('WF_OK::') ? joined.slice('WF_OK::'.length) : joined

    // 从所有行里提取所有 JSON 对象（同一行可能有多个拼接），找含 key/result 的那个
    const extractJsonObjects = (s: string): any[] => {
      const results: any[] = []
      const re = /\{[^{}]*\}/g
      let m: RegExpExecArray | null
      while ((m = re.exec(s)) !== null) {
        try { results.push(JSON.parse(m[0])) } catch { }
      }
      return results
    }
    const fullOutput = normalizedOutput
    const allJson = extractJsonObjects(fullOutput)
    // 优先找 success=true && key 字段
    const successPayload = allJson.find(p => p?.success === true && typeof p?.key === 'string')
    if (successPayload) return successPayload.key
    // 其次找 result 字段
    const resultPayload = allJson.find(p => typeof p?.result === 'string')
    if (resultPayload) return resultPayload.result
    throw new Error('elevated helper returned invalid json: ' + lines[lines.length - 1])
  }

  private mapDbKeyErrorMessage(code?: string, detail?: string): string {
    if (code === 'PROCESS_NOT_FOUND') return '微信进程未运行'
    if (code === 'ATTACH_FAILED') {
      const isDevElectron = process.execPath.includes('/node_modules/electron/')
      if ((detail || '').includes('task_for_pid:5')) {
        if (isDevElectron) {
          return `无法附加到微信进程（task_for_pid 被拒绝）。当前为开发环境 Electron：${process.execPath}\n建议使用打包后的 WeFlow.app（已携带调试 entitlements）再重试。`
        }
        return '无法附加到微信进程（task_for_pid 被系统拒绝）。请确认当前运行程序已正确签名并包含调试 entitlements。'
      }
      return `无法附加到进程 (${detail || ''})`
    }
    if (code === 'FRIDA_FAILED') {
      if ((detail || '').includes('FRIDA_TIMEOUT')) {
        return '定位已成功但在等待时间内未捕获到密钥调用。请保持微信前台并进行一次会话/数据库访问后重试。'
      }
      return `Frida 语义定位失败 (${detail || ''})`
    }
    if (code === 'HOOK_FAILED') {
      if ((detail || '').includes('HOOK_TIMEOUT')) {
        return 'Hook 已安装，但在等待时间内未触发目标函数。请保持微信前台并执行一次会话/数据库访问后重试。'
      }
      if ((detail || '').includes('attach_wait_timeout')) {
        return '附加调试器超时，未能进入 Hook 阶段。请确认微信处于可交互状态并重试。'
      }
      return `原生 Hook 失败 (${detail || ''})`
    }
    if (code === 'HOOK_TARGET_ONLY') {
      return `已定位到目标函数地址（${detail || ''}），但当前原生 C++ 仅完成定位，尚未完成远程 Hook 回调取 key 流程。`
    }
    if (code === 'SCAN_FAILED') return '内存扫描失败'
    return '未知错误'
  }

  private async enableDebugPermissionWithPrompt(): Promise<boolean> {
    const script = [
      'do shell script "/usr/sbin/DevToolsSecurity -enable" with administrator privileges'
    ]

    try {
      await execFileAsync('/usr/bin/osascript', script.flatMap(line => ['-e', line]), {
        timeout: 30_000
      })
      return true
    } catch (e: any) {
      const msg = `${e?.stderr || ''}\n${e?.message || ''}`
      const cancelled = msg.includes('User canceled') || msg.includes('(-128)')
      if (!cancelled) {
        console.error('[KeyServiceMac] enableDebugPermissionWithPrompt failed:', msg)
      }
      return false
    }
  }

  private async openDeveloperToolsPrivacySettings(): Promise<void> {
    const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_DevTools'
    try {
      await shell.openExternal(url)
    } catch (e) {
      console.error('[KeyServiceMac] Failed to open settings page:', e)
    }
  }

  private async revealCurrentExecutableInFinder(): Promise<void> {
    try {
      shell.showItemInFolder(process.execPath)
    } catch (e) {
      console.error('[KeyServiceMac] Failed to reveal executable in Finder:', e)
    }
  }

  async autoGetImageKey(
    accountPath?: string,
    onStatus?: (message: string) => void,
    wxid?: string
  ): Promise<ImageKeyResult> {
    try {
      onStatus?.('正在从缓存目录扫描图片密钥...')
      const codes = this.collectKvcommCodes(accountPath)
      if (codes.length === 0) {
        return { success: false, error: '未找到有效的密钥码（kvcomm 缓存为空）' }
      }

      const wxidCandidates = this.collectWxidCandidates(accountPath, wxid)
      if (wxidCandidates.length === 0) {
        return { success: false, error: '未找到可用的账号候选，请先选择正确的账号目录' }
      }

      const accountPathCandidates = this.collectAccountPathCandidates(accountPath)

      // 使用模板密文做验真，避免 wxid 不匹配导致快速方案算错
      if (accountPathCandidates.length > 0) {
        onStatus?.(`正在校验候选 wxid（${wxidCandidates.length} 个）...`)
        for (const candidateAccountPath of accountPathCandidates) {
          if (!existsSync(candidateAccountPath)) continue
          const template = await this._findTemplateData(candidateAccountPath, 32)
          if (!template.ciphertext) continue

          const accountDirWxid = basename(candidateAccountPath)
          const orderedWxids: string[] = []
          this.pushAccountIdCandidates(orderedWxids, accountDirWxid)
          for (const candidate of wxidCandidates) {
            this.pushAccountIdCandidates(orderedWxids, candidate)
          }

          for (const candidateWxid of orderedWxids) {
            for (const code of codes) {
              const { xorKey, aesKey } = this.deriveImageKeys(code, candidateWxid)
              if (!this.verifyDerivedAesKey(aesKey, template.ciphertext)) continue
              onStatus?.(`密钥获取成功 (wxid: ${candidateWxid}, code: ${code})`)
              return { success: true, xorKey, aesKey }
            }
          }
        }
        return {
          success: false,
          error: '缓存 code 与当前账号 wxid 未匹配。若数据库密钥获取后微信刚刚崩溃并重启，可能当前选中的账号目录已经不是最新会话；请先重新扫描 wxid，或直接使用内存扫描。'
        }
      }

      // 无法获取模板密文时，回退为历史策略（优先级最高候选 + 第一条 code）
      const fallbackWxid = wxidCandidates[0]
      const fallbackCode = codes[0]
      const { xorKey, aesKey } = this.deriveImageKeys(fallbackCode, fallbackWxid)
      onStatus?.(`密钥获取成功 (wxid: ${fallbackWxid}, code: ${fallbackCode})`)
      return { success: true, xorKey, aesKey }
    } catch (e: any) {
      return { success: false, error: `自动获取图片密钥失败: ${e.message}` }
    }
  }

  async autoGetImageKeyByMemoryScan(
    userDir: string,
    onProgress?: (message: string) => void
  ): Promise<ImageKeyResult> {
    try {
      // 1. 查找模板文件获取密文和 XOR 密钥
      onProgress?.('正在查找模板文件...')
      let result = await this._findTemplateData(userDir, 32)
      let { ciphertext, xorKey } = result
      
      if (ciphertext && xorKey === null) {
        onProgress?.('未找到有效密钥，尝试扫描更多文件...')
        result = await this._findTemplateData(userDir, 100)
        xorKey = result.xorKey
      }
      
      if (!ciphertext) return { success: false, error: '未找到 V2 模板文件，请先在微信中查看几张图片' }
      if (xorKey === null) return { success: false, error: '未能从模板文件中计算出有效的 XOR 密钥' }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      // 2. 持续轮询微信 PID 与内存扫描，兼容微信崩溃后重启 PID 变化
      const deadline = Date.now() + 60_000
      let scanCount = 0
      let lastPid: number | null = null
      while (Date.now() < deadline) {
        const pid = await this.findWeChatPid()
        if (!pid) {
          onProgress?.('暂未检测到微信主进程，请确认微信已经重新打开...')
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        if (lastPid !== pid) {
          lastPid = pid
          onProgress?.(`已找到微信进程 PID=${pid}，正在扫描内存...`)
        }
        scanCount++
        onProgress?.(`第 ${scanCount} 次扫描内存，请在微信中打开图片大图...`)
        const aesKey = await this._scanMemoryForAesKey(pid, ciphertext, onProgress)
        if (aesKey) {
          onProgress?.('密钥获取成功')
          return { success: true, xorKey, aesKey }
        }
        await new Promise(r => setTimeout(r, 5000))
      }

      return { success: false, error: '60 秒内未找到 AES 密钥' }
    } catch (e: any) {
      return { success: false, error: `内存扫描失败: ${e.message}` }
    }
  }

  private async _findTemplateData(userDir: string, limit: number = 32): Promise<{ ciphertext: Buffer | null; xorKey: number | null }> {
    const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

    const collect = (dir: string, results: string[], maxFiles: number) => {
      if (results.length >= maxFiles) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) break
          const full = join(dir, entry.name)
          if (entry.isDirectory()) collect(full, results, maxFiles)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) results.push(full)
        }
      } catch { }
    }

    const files: string[] = []
    collect(userDir, files, limit)

    files.sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
    })

    let ciphertext: Buffer | null = null
    const tailCounts: Record<string, number> = {}

    for (const f of files.slice(0, 32)) {
      try {
        const data = readFileSync(f)
        if (data.length < 8) continue

        if (data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 2) {
          const key = `${data[data.length - 2]}_${data[data.length - 1]}`
          tailCounts[key] = (tailCounts[key] ?? 0) + 1
        }

        if (!ciphertext && data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 0x1F) {
          ciphertext = data.subarray(0xF, 0x1F)
        }
      } catch { }
    }

    let xorKey: number | null = null
    let maxCount = 0
    for (const [key, count] of Object.entries(tailCounts)) {
      if (count > maxCount) { 
        maxCount = count
        const [x, y] = key.split('_').map(Number)
        const k = x ^ 0xFF
        if (k === (y ^ 0xD9)) xorKey = k
      }
    }

    return { ciphertext, xorKey }
  }

  private ensureMachApis(): boolean {
    if (this.machTaskSelf && this.taskForPid && this.machVmRegion && this.machVmReadOverwrite) return true
    try {
      if (!this.koffi) this.koffi = require('koffi')
      this.libSystem = this.koffi.load('/usr/lib/libSystem.B.dylib')
      this.machTaskSelf = this.libSystem.func('mach_task_self', 'uint32', [])
      this.taskForPid = this.libSystem.func('task_for_pid', 'int', ['uint32', 'int', this.koffi.out('uint32*')])
      this.machVmRegion = this.libSystem.func('mach_vm_region', 'int', [
        'uint32',
        this.koffi.out('uint64*'),
        this.koffi.out('uint64*'),
        'int',
        'void*',
        this.koffi.out('uint32*'),
        this.koffi.out('uint32*')
      ])
      this.machVmReadOverwrite = this.libSystem.func('mach_vm_read_overwrite', 'int', [
        'uint32',
        'uint64',
        'uint64',
        'void*',
        this.koffi.out('uint64*')
      ])
      this.machPortDeallocate = this.libSystem.func('mach_port_deallocate', 'int', ['uint32', 'uint32'])
      return true
    } catch (e) {
      console.error('[KeyServiceMac] 初始化 Mach API 失败:', e)
      return false
    }
  }

  private async _scanMemoryForAesKey(
    pid: number,
    ciphertext: Buffer,
    onProgress?: (message: string) => void
  ): Promise<string | null> {
    // 优先通过 image_scan_helper 子进程调用
    try {
      const helperPath = this.getImageScanHelperPath()
      const ciphertextHex = ciphertext.toString('hex')

      // 1) 直接运行 helper（有正式签名的 debugger entitlement 时可用）
      if (!this._needsElevation) {
        const direct = await this._spawnScanHelper(helperPath, pid, ciphertextHex, false)
        if (direct.key) return direct.key
        if (direct.permissionError) {
          console.warn('[KeyServiceMac] task_for_pid 权限不足，切换到 osascript 提权模式')
          this._needsElevation = true
          onProgress?.('需要管理员权限，请在弹出的对话框中输入密码...')
        }
      }

      // 2) 通过 osascript 以管理员权限运行 helper（SIP 下 ad-hoc 签名无法获取 task_for_pid）
      if (this._needsElevation) {
        const elevated = await this._spawnScanHelper(helperPath, pid, ciphertextHex, true)
        if (elevated.key) return elevated.key
      }
    } catch (e: any) {
      console.warn('[KeyServiceMac] image_scan_helper unavailable, fallback to Mach API:', e?.message)
    }

    // fallback: 直接通过 Mach API 扫描内存（Electron 进程可能没有 task_for_pid 权限）
    if (!this.ensureMachApis()) return null

    const VM_PROT_READ = 0x1
    const VM_PROT_WRITE = 0x2
    const VM_REGION_BASIC_INFO_64 = 9
    const VM_REGION_BASIC_INFO_COUNT_64 = 9
    const KERN_SUCCESS = 0
    const MAX_REGION_SIZE = 50 * 1024 * 1024
    const CHUNK = 4 * 1024 * 1024
    const OVERLAP = 65

    const selfTask = this.machTaskSelf()
    const taskBuf = Buffer.alloc(4)
    const attachKr = this.taskForPid(selfTask, pid, taskBuf)
    const task = taskBuf.readUInt32LE(0)
    if (attachKr !== KERN_SUCCESS || !task) return null

    try {
      const regions: Array<[number, number]> = []
      let address = 0

      while (address < 0x7FFFFFFFFFFF) {
        const addrBuf = Buffer.alloc(8)
        addrBuf.writeBigUInt64LE(BigInt(address), 0)
        const sizeBuf = Buffer.alloc(8)
        const infoBuf = Buffer.alloc(64)
        const countBuf = Buffer.alloc(4)
        countBuf.writeUInt32LE(VM_REGION_BASIC_INFO_COUNT_64, 0)
        const objectBuf = Buffer.alloc(4)

        const kr = this.machVmRegion(task, addrBuf, sizeBuf, VM_REGION_BASIC_INFO_64, infoBuf, countBuf, objectBuf)
        if (kr !== KERN_SUCCESS) break

        const base = Number(addrBuf.readBigUInt64LE(0))
        const size = Number(sizeBuf.readBigUInt64LE(0))
        const protection = infoBuf.readInt32LE(0)
        const objectName = objectBuf.readUInt32LE(0)
        if (objectName) {
          try { this.machPortDeallocate(selfTask, objectName) } catch { }
        }

        if ((protection & VM_PROT_READ) !== 0 &&
            (protection & VM_PROT_WRITE) !== 0 &&
            size > 0 &&
            size <= MAX_REGION_SIZE) {
          regions.push([base, size])
        }

        const next = base + size
        if (next <= address) break
        address = next
      }

      const totalMB = regions.reduce((sum, [, size]) => sum + size, 0) / 1024 / 1024
      onProgress?.(`扫描 ${regions.length} 个 RW 区域 (${totalMB.toFixed(0)} MB)...`)

      for (let ri = 0; ri < regions.length; ri++) {
        const [base, size] = regions[ri]
        if (ri % 20 === 0) {
          onProgress?.(`扫描进度 ${ri}/${regions.length}...`)
          await new Promise(r => setTimeout(r, 1))
        }
        let offset = 0
        let trailing: Buffer | null = null

        while (offset < size) {
          const chunkSize = Math.min(CHUNK, size - offset)
          const chunk = Buffer.alloc(chunkSize)
          const outSizeBuf = Buffer.alloc(8)
          const kr = this.machVmReadOverwrite(task, base + offset, chunkSize, chunk, outSizeBuf)
          const bytesRead = Number(outSizeBuf.readBigUInt64LE(0))
          offset += chunkSize

          if (kr !== KERN_SUCCESS || bytesRead <= 0) {
            trailing = null
            continue
          }

          const current = chunk.subarray(0, bytesRead)
          const data: Buffer = trailing ? Buffer.concat([trailing, current]) : current
          const key = this._searchAsciiKey(data, ciphertext) || this._searchUtf16Key(data, ciphertext)
          if (key) return key
          // 兜底：兼容旧 C++ 的滑窗 16-byte 扫描（严格规则 miss 时仍可命中）
          const fallbackKey = this._searchAny16Key(data, ciphertext)
          if (fallbackKey) return fallbackKey
          trailing = data.subarray(Math.max(0, data.length - OVERLAP))
        }
      }
      return null
    } finally {
      try { this.machPortDeallocate(selfTask, task) } catch { }
    }
  }

  private _spawnScanHelper(
    helperPath: string, pid: number, ciphertextHex: string, elevated: boolean
  ): Promise<{ key: string | null; permissionError: boolean }> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      if (elevated) {
        const shellCmd = `'${helperPath}' ${pid} ${ciphertextHex}`
        child = spawn('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(shellCmd)} with administrator privileges`],
          { stdio: ['ignore', 'pipe', 'pipe'] })
      } else {
        child = spawn(helperPath, [String(pid), ciphertextHex], { stdio: ['ignore', 'pipe', 'pipe'] })
      }
      const tag = elevated ? '[image_scan_helper:elevated]' : '[image_scan_helper]'
      let stdout = '', stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        console.log(tag, chunk.toString().trim())
      })
      child.on('error', reject)
      child.on('close', () => {
        const permissionError = !elevated && stderr.includes('task_for_pid failed')
        try {
          const lines = stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
          const last = lines[lines.length - 1]
          if (!last) { resolve({ key: null, permissionError }); return }
          const payload = JSON.parse(last)
          resolve({
            key: payload?.success && payload?.aesKey ? payload.aesKey : null,
            permissionError
          })
        } catch {
          resolve({ key: null, permissionError })
        }
      })
      setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, elevated ? 60_000 : 30_000)
    })
  }

  private async findWeChatPid(): Promise<number | null> {
    try {
      return await this.getWeChatPid()
    } catch {
      return null
    }
  }

  cleanup(): void {
    this.lib = null
    this.initialized = false
    this.libSystem = null
    this.machTaskSelf = null
    this.taskForPid = null
    this.machVmRegion = null
    this.machVmReadOverwrite = null
    this.machPortDeallocate = null
  }

  private normalizeAccountId(value: string): string {
    const trimmed = String(value || '').trim()
    if (!trimmed) return ''

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      return match?.[1] || trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    return suffixMatch ? suffixMatch[1] : trimmed
  }

  private isIgnoredAccountName(value: string): boolean {
    const lowered = String(value || '').trim().toLowerCase()
    if (!lowered) return true
    return lowered === 'xwechat_files' ||
      lowered === 'all_users' ||
      lowered === 'backup' ||
      lowered === 'wmpf' ||
      lowered === 'app_data'
  }

  private isReasonableAccountId(value: string): boolean {
    const trimmed = String(value || '').trim()
    if (!trimmed) return false
    if (trimmed.includes('/') || trimmed.includes('\\')) return false
    return !this.isIgnoredAccountName(trimmed)
  }

  private isAccountDirPath(entryPath: string): boolean {
    return existsSync(join(entryPath, 'db_storage')) ||
      existsSync(join(entryPath, 'msg')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image2'))
  }

  private resolveXwechatRootFromPath(accountPath?: string): string | null {
    const normalized = String(accountPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalized) return null

    // 旧路径：xwechat_files
    const marker = '/xwechat_files'
    const markerIdx = normalized.indexOf(marker)
    if (markerIdx >= 0) return normalized.slice(0, markerIdx + marker.length)

    // 新路径（微信 4.0.5+）：Application Support/com.tencent.xinWeChat/2.0b4.0.9
    const newMarkerMatch = normalized.match(/^(.*\/com\.tencent\.xinWeChat\/(?:\d+\.\d+b\d+\.\d+|\d+\.\d+\.\d+))(\/|$)/)
    if (newMarkerMatch) return newMarkerMatch[1]

    return null
  }

  private pushAccountIdCandidates(candidates: string[], value?: string): void {
    const pushUnique = (item: string) => {
      const trimmed = String(item || '').trim()
      if (!trimmed || candidates.includes(trimmed)) return
      candidates.push(trimmed)
    }

    const raw = String(value || '').trim()
    if (!this.isReasonableAccountId(raw)) return
    pushUnique(raw)
    const normalized = this.normalizeAccountId(raw)
    if (normalized && normalized !== raw && this.isReasonableAccountId(normalized)) {
      pushUnique(normalized)
    }
  }

  private cleanWxid(wxid: string): string {
    return this.normalizeAccountId(wxid)
  }

  private deriveImageKeys(code: number, wxid: string): { xorKey: number; aesKey: string } {
    const cleanedWxid = this.cleanWxid(wxid)
    const xorKey = code & 0xFF
    const dataToHash = code.toString() + cleanedWxid
    const aesKey = crypto.createHash('md5').update(dataToHash).digest('hex').substring(0, 16)
    return { xorKey, aesKey }
  }

  private collectWxidCandidates(accountPath?: string, wxidParam?: string): string[] {
    const candidates: string[] = []

    // 1) 显式传参优先
    this.pushAccountIdCandidates(candidates, wxidParam)

    if (accountPath) {
      const normalized = accountPath.replace(/\\/g, '/').replace(/\/+$/, '')
      const dirName = basename(normalized)
      // 2) 当前目录名本身就是账号目录
      this.pushAccountIdCandidates(candidates, dirName)

      // 3) 从 xwechat_files 根目录枚举全部账号目录
      const root = this.resolveXwechatRootFromPath(accountPath)
      if (root) {
        if (existsSync(root)) {
          try {
            for (const entry of readdirSync(root, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue
              const entryPath = join(root, entry.name)
              if (!this.isAccountDirPath(entryPath)) continue
              this.pushAccountIdCandidates(candidates, entry.name)
            }
          } catch {
            // ignore
          }
        }
      }
    }

    if (candidates.length === 0) candidates.push('unknown')
    return candidates
  }

  private collectAccountPathCandidates(accountPath?: string): string[] {
    const candidates: string[] = []
    const pushUnique = (value?: string) => {
      const v = String(value || '').trim()
      if (!v || candidates.includes(v)) return
      candidates.push(v)
    }

    if (accountPath) pushUnique(accountPath)

    if (accountPath) {
      const root = this.resolveXwechatRootFromPath(accountPath)
      if (root) {
        if (existsSync(root)) {
          try {
            for (const entry of readdirSync(root, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue
              const entryPath = join(root, entry.name)
              if (!this.isAccountDirPath(entryPath)) continue
              if (!this.isReasonableAccountId(entry.name)) continue
              pushUnique(entryPath)
            }
          } catch {
            // ignore
          }
        }
      }
    }

    return candidates
  }

  private verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
    try {
      if (!aesKey || aesKey.length < 16 || ciphertext.length !== 16) return false
      const keyBytes = Buffer.from(aesKey, 'ascii').subarray(0, 16)
      const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes, null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) return true
      if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) return true
      if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return true
      if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return true
      if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return true
      return false
    } catch {
      return false
    }
  }

  private collectKvcommCodes(accountPath?: string): number[] {
    const codeSet = new Set<number>()
    const pattern = /^key_(\d+)_.+\.statistic$/i

    for (const kvcommDir of this.getKvcommCandidates(accountPath)) {
      if (!existsSync(kvcommDir)) continue
      try {
        const files = readdirSync(kvcommDir)
        for (const file of files) {
          const match = file.match(pattern)
          if (!match) continue
          const code = Number(match[1])
          if (!Number.isFinite(code) || code <= 0 || code > 0xFFFFFFFF) continue
          codeSet.add(code)
        }
      } catch {
        // 忽略不可读目录，继续尝试其他候选路径
      }
    }

    return Array.from(codeSet)
  }

  private getKvcommCandidates(accountPath?: string): string[] {
    const home = homedir()
    const candidates = new Set<string>([
      // 与用户实测路径一致：Documents/xwechat_files -> Documents/app_data/net/kvcomm
      join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'app_data', 'net', 'kvcomm'),
      join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat', 'xwechat', 'net', 'kvcomm'),
      join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat', 'net', 'kvcomm'),
      join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat', 'net', 'kvcomm')
    ])

    if (accountPath) {
      // 规则：把路径中的 xwechat_files 替换为 app_data，然后拼 net/kvcomm
      const normalized = accountPath.replace(/\\/g, '/').replace(/\/+$/, '')
      const marker = '/xwechat_files'
      const idx = normalized.indexOf(marker)
      if (idx >= 0) {
        const base = normalized.slice(0, idx)
        candidates.add(`${base}/app_data/net/kvcomm`)
      }

      // 微信 4.0.5+ 新路径推导：版本目录同级的 net/kvcomm
      const newMarkerMatch = normalized.match(/^(.*\/com\.tencent\.xinWeChat\/(?:\d+\.\d+b\d+\.\d+|\d+\.\d+\.\d+))/)
      if (newMarkerMatch) {
        const versionBase = newMarkerMatch[1]
        candidates.add(`${versionBase}/net/kvcomm`)
        // 上级目录也尝试
        const parentBase = versionBase.replace(/\/[^\/]+$/, '')
        candidates.add(`${parentBase}/net/kvcomm`)
      }

      let cursor = accountPath
      for (let i = 0; i < 6; i++) {
        candidates.add(join(cursor, 'net', 'kvcomm'))
        const next = dirname(cursor)
        if (next === cursor) break
        cursor = next
      }
    }

    return Array.from(candidates)
  }

  private _searchAsciiKey(data: Buffer, ciphertext: Buffer): string | null {
    for (let i = 0; i < data.length - 34; i++) {
      if (this._isAlphaNum(data[i])) continue
      let valid = true
      for (let j = 1; j <= 32; j++) {
        if (!this._isAlphaNum(data[i + j])) { valid = false; break }
      }
      if (!valid) continue
      if (i + 33 < data.length && this._isAlphaNum(data[i + 33])) continue
      const keyBytes = data.subarray(i + 1, i + 33)
      if (this._verifyAesKey(keyBytes, ciphertext)) return keyBytes.toString('ascii').substring(0, 16)
    }
    return null
  }

  private _searchUtf16Key(data: Buffer, ciphertext: Buffer): string | null {
    for (let i = 0; i < data.length - 65; i++) {
      let valid = true
      for (let j = 0; j < 32; j++) {
        if (data[i + j * 2 + 1] !== 0x00 || !this._isAlphaNum(data[i + j * 2])) { valid = false; break }
      }
      if (!valid) continue
      const keyBytes = Buffer.alloc(32)
      for (let j = 0; j < 32; j++) keyBytes[j] = data[i + j * 2]
      if (this._verifyAesKey(keyBytes, ciphertext)) return keyBytes.toString('ascii').substring(0, 16)
    }
    return null
  }

  private _isAlphaNum(b: number): boolean {
    return (b >= 0x61 && b <= 0x7A) || (b >= 0x41 && b <= 0x5A) || (b >= 0x30 && b <= 0x39)
  }

  private _verifyAesKey(keyBytes: Buffer, ciphertext: Buffer): boolean {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes.subarray(0, 16), null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) return true
      if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) return true
      if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return true
      if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return true
      if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return true
      return false
    } catch {
      return false
    }
  }

  // 兜底策略：遍历任意 16-byte 候选，提升 macOS 内存布局差异下的命中率
  private _searchAny16Key(data: Buffer, ciphertext: Buffer): string | null {
    for (let i = 0; i + 16 <= data.length; i++) {
      const keyBytes = data.subarray(i, i + 16)
      if (!this._verifyAesKey16Raw(keyBytes, ciphertext)) continue
      if (!this._isMostlyPrintableAscii(keyBytes)) continue
      return keyBytes.toString('ascii')
    }
    return null
  }

  private _verifyAesKey16Raw(keyBytes16: Buffer, ciphertext: Buffer): boolean {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes16, null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) return true
      if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) return true
      if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return true
      if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return true
      if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return true
      return false
    } catch {
      return false
    }
  }

  private _isMostlyPrintableAscii(keyBytes16: Buffer): boolean {
    let printable = 0
    for (const b of keyBytes16) {
      if (b >= 0x20 && b <= 0x7E) printable++
    }
    return printable >= 14
  }
}
