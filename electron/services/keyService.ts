import { app } from 'electron'
import { join, dirname, basename } from 'path'
import { existsSync, readdirSync, readFileSync, statSync, copyFileSync, mkdirSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import os from 'os'

const execFileAsync = promisify(execFile)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; error?: string }

export class KeyService {
  private koffi: any = null
  private lib: any = null
  private initialized = false
  private initHook: any = null
  private pollKeyData: any = null
  private getStatusMessage: any = null
  private cleanupHook: any = null
  private getLastErrorMsg: any = null

  // Win32 APIs
  private kernel32: any = null
  private user32: any = null
  private advapi32: any = null

  // Kernel32
  private OpenProcess: any = null
  private CloseHandle: any = null
  private VirtualQueryEx: any = null
  private ReadProcessMemory: any = null
  private MEMORY_BASIC_INFORMATION: any = null
  private TerminateProcess: any = null
  private QueryFullProcessImageNameW: any = null

  // User32
  private EnumWindows: any = null
  private GetWindowTextW: any = null
  private GetWindowTextLengthW: any = null
  private GetClassNameW: any = null
  private GetWindowThreadProcessId: any = null
  private IsWindowVisible: any = null
  private EnumChildWindows: any = null
  private WNDENUMPROC_PTR: any = null

  // Advapi32
  private RegOpenKeyExW: any = null
  private RegQueryValueExW: any = null
  private RegCloseKey: any = null

  // Constants
  private readonly PROCESS_ALL_ACCESS = 0x1F0FFF
  private readonly PROCESS_TERMINATE = 0x0001
  private readonly KEY_READ = 0x20019
  private readonly HKEY_LOCAL_MACHINE = 0x80000002
  private readonly HKEY_CURRENT_USER = 0x80000001
  private readonly ERROR_SUCCESS = 0

  private getDllPath(): string {
    const isPackaged = typeof app !== 'undefined' && app ? app.isPackaged : process.env.NODE_ENV === 'production'

    // 候选路径列表
    const candidates: string[] = []

    // 1. 显式环境变量 (最高优先级)
    if (process.env.WX_KEY_DLL_PATH) {
      candidates.push(process.env.WX_KEY_DLL_PATH)
    }

    if (isPackaged) {
      // 生产环境: 通常在 resources 目录下，但也可能直接在 resources 根目录
      candidates.push(join(process.resourcesPath, 'resources', 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'wx_key.dll'))
    } else {
      // 开发环境
      const cwd = process.cwd()
      candidates.push(join(cwd, 'resources', 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'wx_key.dll'))
    }

    // 检查并返回第一个存在的路径
    for (const path of candidates) {
      if (existsSync(path)) {
        return path
      }
    }

    // 如果都没找到，返回最可能的路径以便报错信息有参考
    return candidates[0]
  }

  // 检查路径是否为 UNC 路径或网络路径
  private isNetworkPath(path: string): boolean {
    // UNC 路径以 \\ 开头
    if (path.startsWith('\\\\')) {
      return true
    }
    // 检查是否为网络映射驱动器（简化检测：A: 表示驱动器）
    // 注意：这是一个启发式检测，更准确的方式需要调用 GetDriveType Windows API
    // 但对于大多数 VM 共享场景，UNC 路径检测已足够
    return false
  }

  // 将 DLL 复制到本地临时目录
  private localizeNetworkDll(originalPath: string): string {
    try {
      const tempDir = join(os.tmpdir(), 'weflow_dll_cache')
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true })
      }
      const localPath = join(tempDir, 'wx_key.dll')

      // 检查是否已经有本地副本，如果有就使用它
      if (existsSync(localPath)) {
        console.log(`使用已存在的 DLL 本地副本: ${localPath}`)
        return localPath
      }

      console.log(`检测到网络路径 DLL，正在复制到本地: ${originalPath} -> ${localPath}`)
      copyFileSync(originalPath, localPath)
      console.log('DLL 本地化成功')
      return localPath
    } catch (e) {
      console.error('DLL 本地化失败:', e)
      // 如果本地化失败，返回原路径
      return originalPath
    }
  }

  private ensureLoaded(): boolean {
    if (this.initialized) return true

    let dllPath = ''
    try {
      this.koffi = require('koffi')
      dllPath = this.getDllPath()

      if (!existsSync(dllPath)) {
        console.error(`wx_key.dll 不存在于路径: ${dllPath}`)
        return false
      }

      // 检查是否为网络路径，如果是则本地化
      if (this.isNetworkPath(dllPath)) {
        console.log('检测到网络路径，将进行本地化处理')
        dllPath = this.localizeNetworkDll(dllPath)
      }

      this.lib = this.koffi.load(dllPath)
      this.initHook = this.lib.func('bool InitializeHook(uint32 targetPid)')
      this.pollKeyData = this.lib.func('bool PollKeyData(_Out_ char *keyBuffer, int bufferSize)')
      this.getStatusMessage = this.lib.func('bool GetStatusMessage(_Out_ char *msgBuffer, int bufferSize, _Out_ int *outLevel)')
      this.cleanupHook = this.lib.func('bool CleanupHook()')
      this.getLastErrorMsg = this.lib.func('const char* GetLastErrorMsg()')

      this.initialized = true
      return true
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      const errorStack = e instanceof Error ? e.stack : ''
      console.error(`加载 wx_key.dll 失败`)
      console.error(`  路径: ${dllPath}`)
      console.error(`  错误: ${errorMsg}`)
      if (errorStack) {
        console.error(`  堆栈: ${errorStack}`)
      }
      return false
    }
  }

  private ensureWin32(): boolean {
    return process.platform === 'win32'
  }

  private ensureKernel32(): boolean {
    if (this.kernel32) return true
    try {
      this.koffi = require('koffi')
      this.kernel32 = this.koffi.load('kernel32.dll')

      const HANDLE = this.koffi.pointer('HANDLE', this.koffi.opaque())
      this.MEMORY_BASIC_INFORMATION = this.koffi.struct('MEMORY_BASIC_INFORMATION', {
        BaseAddress: 'uint64',
        AllocationBase: 'uint64',
        AllocationProtect: 'uint32',
        RegionSize: 'uint64',
        State: 'uint32',
        Protect: 'uint32',
        Type: 'uint32'
      })

      // Use explicit definitions to avoid parser issues
      this.OpenProcess = this.kernel32.func('OpenProcess', 'HANDLE', ['uint32', 'bool', 'uint32'])
      this.CloseHandle = this.kernel32.func('CloseHandle', 'bool', ['HANDLE'])
      this.TerminateProcess = this.kernel32.func('TerminateProcess', 'bool', ['HANDLE', 'uint32'])
      this.QueryFullProcessImageNameW = this.kernel32.func('QueryFullProcessImageNameW', 'bool', ['HANDLE', 'uint32', this.koffi.out('uint16*'), this.koffi.out('uint32*')])
      this.VirtualQueryEx = this.kernel32.func('VirtualQueryEx', 'uint64', ['HANDLE', 'uint64', this.koffi.out(this.koffi.pointer(this.MEMORY_BASIC_INFORMATION)), 'uint64'])
      this.ReadProcessMemory = this.kernel32.func('ReadProcessMemory', 'bool', ['HANDLE', 'uint64', 'void*', 'uint64', this.koffi.out(this.koffi.pointer('uint64'))])

      return true
    } catch (e) {
      console.error('初始化 kernel32 失败:', e)
      return false
    }
  }

  private decodeUtf8(buf: Buffer): string {
    const nullIdx = buf.indexOf(0)
    return buf.toString('utf8', 0, nullIdx > -1 ? nullIdx : undefined).trim()
  }

  private ensureUser32(): boolean {
    if (this.user32) return true
    try {
      this.koffi = require('koffi')
      this.user32 = this.koffi.load('user32.dll')

      // Callbacks
      // Define the prototype and its pointer type
      const WNDENUMPROC = this.koffi.proto('bool __stdcall (void *hWnd, intptr_t lParam)')
      this.WNDENUMPROC_PTR = this.koffi.pointer(WNDENUMPROC)

      this.EnumWindows = this.user32.func('EnumWindows', 'bool', [this.WNDENUMPROC_PTR, 'intptr_t'])
      this.EnumChildWindows = this.user32.func('EnumChildWindows', 'bool', ['void*', this.WNDENUMPROC_PTR, 'intptr_t'])

      this.GetWindowTextW = this.user32.func('GetWindowTextW', 'int', ['void*', this.koffi.out('uint16*'), 'int'])
      this.GetWindowTextLengthW = this.user32.func('GetWindowTextLengthW', 'int', ['void*'])
      this.GetClassNameW = this.user32.func('GetClassNameW', 'int', ['void*', this.koffi.out('uint16*'), 'int'])
      this.GetWindowThreadProcessId = this.user32.func('GetWindowThreadProcessId', 'uint32', ['void*', this.koffi.out('uint32*')])
      this.IsWindowVisible = this.user32.func('IsWindowVisible', 'bool', ['void*'])

      return true
    } catch (e) {
      console.error('初始化 user32 失败:', e)
      return false
    }
  }

  private ensureAdvapi32(): boolean {
    if (this.advapi32) return true
    try {
      this.koffi = require('koffi')
      this.advapi32 = this.koffi.load('advapi32.dll')

      // Types
      // Use intptr_t for HKEY to match system architecture (64-bit safe)
      const HKEY = this.koffi.alias('HKEY', 'intptr_t')
      const HKEY_PTR = this.koffi.pointer(HKEY)

      this.RegOpenKeyExW = this.advapi32.func('RegOpenKeyExW', 'long', [HKEY, 'uint16*', 'uint32', 'uint32', this.koffi.out(HKEY_PTR)])
      this.RegQueryValueExW = this.advapi32.func('RegQueryValueExW', 'long', [HKEY, 'uint16*', 'uint32*', this.koffi.out('uint32*'), this.koffi.out('uint8*'), this.koffi.out('uint32*')])
      this.RegCloseKey = this.advapi32.func('RegCloseKey', 'long', [HKEY])

      return true
    } catch (e) {
      console.error('初始化 advapi32 失败:', e)
      return false
    }
  }

  private decodeCString(ptr: any): string {
    try {
      if (typeof ptr === 'string') return ptr
      return this.koffi.decode(ptr, 'char', -1)
    } catch {
      return ''
    }
  }

  // --- WeChat Process & Path Finding ---

  // Helper to read simple registry string
  private readRegistryString(rootKey: number, subKey: string, valueName: string): string | null {
    if (!this.ensureAdvapi32()) return null

    // Convert strings to UTF-16 buffers
    const subKeyBuf = Buffer.from(subKey + '\0', 'ucs2')
    const valueNameBuf = valueName ? Buffer.from(valueName + '\0', 'ucs2') : null

    const phkResult = Buffer.alloc(8) // Pointer size (64-bit safe)

    if (this.RegOpenKeyExW(rootKey, subKeyBuf, 0, this.KEY_READ, phkResult) !== this.ERROR_SUCCESS) {
      return null
    }

    const hKey = this.koffi.decode(phkResult, 'uintptr_t')

    try {
      const lpcbData = Buffer.alloc(4)
      lpcbData.writeUInt32LE(0, 0) // First call to get size? No, RegQueryValueExW expects initialized size or null to get size.
      // Usually we call it twice or just provide a big buffer.
      // Let's call twice.

      let ret = this.RegQueryValueExW(hKey, valueNameBuf, null, null, null, lpcbData)
      if (ret !== this.ERROR_SUCCESS) return null

      const size = lpcbData.readUInt32LE(0)
      if (size === 0) return null

      const dataBuf = Buffer.alloc(size)
      ret = this.RegQueryValueExW(hKey, valueNameBuf, null, null, dataBuf, lpcbData)
      if (ret !== this.ERROR_SUCCESS) return null

      // Read UTF-16 string (remove null terminator)
      let str = dataBuf.toString('ucs2')
      if (str.endsWith('\0')) str = str.slice(0, -1)
      return str
    } finally {
      this.RegCloseKey(hKey)
    }
  }

  private async getProcessExecutablePath(pid: number): Promise<string | null> {
    if (!this.ensureKernel32()) return null
    // 0x1000 = PROCESS_QUERY_LIMITED_INFORMATION
    const hProcess = this.OpenProcess(0x1000, false, pid)
    if (!hProcess) return null

    try {
      const sizeBuf = Buffer.alloc(4)
      sizeBuf.writeUInt32LE(1024, 0)
      const pathBuf = Buffer.alloc(1024 * 2)

      const ret = this.QueryFullProcessImageNameW(hProcess, 0, pathBuf, sizeBuf)
      if (ret) {
        const len = sizeBuf.readUInt32LE(0)
        return pathBuf.toString('ucs2', 0, len * 2)
      }
      return null
    } catch (e) {
      console.error('获取进程路径失败:', e)
      return null
    } finally {
      this.CloseHandle(hProcess)
    }
  }

  private async findWeChatInstallPath(): Promise<string | null> {
    // 0. 优先尝试获取正在运行的微信进程路径
    try {
      const pid = await this.findWeChatPid()
      if (pid) {
        const runPath = await this.getProcessExecutablePath(pid)
        if (runPath && existsSync(runPath)) {
          console.log('发现正在运行的微信进程，使用路径:', runPath)
          return runPath
        }
      }
    } catch (e) {
      console.error('尝试获取运行中微信路径失败:', e)
    }

    // 1. Registry - Uninstall Keys
    const uninstallKeys = [
      'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ]
    const roots = [this.HKEY_LOCAL_MACHINE, this.HKEY_CURRENT_USER]

    // NOTE: Scanning subkeys in registry via Koffi is tedious (RegEnumKeyEx).
    // Simplified strategy: Check common known registry keys first, then fallback to common paths.
    // wx_key searches *all* subkeys of Uninstall, which is robust but complex to port quickly.
    // Let's rely on specific Tencent keys first.

    // 2. Tencent specific keys
    const tencentKeys = [
      'Software\\Tencent\\WeChat',
      'Software\\WOW6432Node\\Tencent\\WeChat',
      'Software\\Tencent\\Weixin',
    ]

    for (const root of roots) {
      for (const key of tencentKeys) {
        const path = this.readRegistryString(root, key, 'InstallPath')
        if (path && existsSync(join(path, 'Weixin.exe'))) return join(path, 'Weixin.exe')
        if (path && existsSync(join(path, 'WeChat.exe'))) return join(path, 'WeChat.exe')
      }
    }

    // 3. Uninstall key exact match (sometimes works)
    for (const root of roots) {
      for (const parent of uninstallKeys) {
        // Try WeChat specific subkey
        const path = this.readRegistryString(root, parent + '\\WeChat', 'InstallLocation')
        if (path && existsSync(join(path, 'Weixin.exe'))) return join(path, 'Weixin.exe')
      }
    }

    // 4. Common Paths
    const drives = ['C', 'D', 'E', 'F']
    const commonPaths = [
      'Program Files\\Tencent\\WeChat\\WeChat.exe',
      'Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
      'Program Files\\Tencent\\Weixin\\Weixin.exe',
      'Program Files (x86)\\Tencent\\Weixin\\Weixin.exe'
    ]

    for (const drive of drives) {
      for (const p of commonPaths) {
        const full = join(drive + ':\\', p)
        if (existsSync(full)) return full
      }
    }

    return null
  }

  private async findPidByImageName(imageName: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'])
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      for (const line of lines) {
        if (line.startsWith('INFO:')) continue
        const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
        if (parts[0]?.toLowerCase() === imageName.toLowerCase()) {
          const pid = Number(parts[1])
          if (!Number.isNaN(pid)) return pid
        }
      }
      return null
    } catch (e) {
      console.error(`获取进程失败 (${imageName}):`, e)
      return null
    }
  }

  private async findWeChatPid(): Promise<number | null> {
    const names = ['Weixin.exe', 'WeChat.exe']
    for (const name of names) {
      const pid = await this.findPidByImageName(name)
      if (pid) return pid
    }

    const fallbackPid = await this.waitForWeChatWindow(5000)
    return fallbackPid ?? null
  }

  private async killWeChatProcesses() {
    try {
      await execFileAsync('taskkill', ['/F', '/IM', 'Weixin.exe'])
      await execFileAsync('taskkill', ['/F', '/IM', 'WeChat.exe'])
    } catch (e) {
      // Ignore if not found
    }
    await new Promise(r => setTimeout(r, 1000))
  }

  // --- Window Detection ---

  private getWindowTitle(hWnd: any): string {
    const len = this.GetWindowTextLengthW(hWnd)
    if (len === 0) return ''
    const buf = Buffer.alloc((len + 1) * 2)
    this.GetWindowTextW(hWnd, buf, len + 1)
    return buf.toString('ucs2', 0, len * 2)
  }

  private getClassName(hWnd: any): string {
    const buf = Buffer.alloc(512)
    const len = this.GetClassNameW(hWnd, buf, 256)
    return buf.toString('ucs2', 0, len * 2)
  }

  private isWeChatWindowTitle(title: string): boolean {
    const normalized = title.trim()
    if (!normalized) return false
    const lower = normalized.toLowerCase()
    return normalized === '微信' || lower === 'wechat' || lower === 'weixin'
  }

  private async waitForWeChatWindow(timeoutMs = 25000): Promise<number | null> {
    if (!this.ensureUser32()) return null
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      let foundPid: number | null = null

      const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
        if (!this.IsWindowVisible(hWnd)) return true
        const title = this.getWindowTitle(hWnd)
        if (!this.isWeChatWindowTitle(title)) return true

        const pidBuf = Buffer.alloc(4)
        this.GetWindowThreadProcessId(hWnd, pidBuf)
        const pid = pidBuf.readUInt32LE(0)
        if (pid) {
          foundPid = pid
          return false
        }
        return true
      }, this.WNDENUMPROC_PTR)

      this.EnumWindows(enumWindowsCallback, 0)
      this.koffi.unregister(enumWindowsCallback)

      if (foundPid) return foundPid
      await new Promise(r => setTimeout(r, 500))
    }
    return null
  }

  private collectChildWindowInfos(parent: any): Array<{ title: string; className: string }> {
    const children: Array<{ title: string; className: string }> = []
    const enumChildCallback = this.koffi.register((hChild: any, lp: any) => {
      const title = this.getWindowTitle(hChild).trim()
      const className = this.getClassName(hChild).trim()
      children.push({ title, className })
      return true
    }, this.WNDENUMPROC_PTR)
    this.EnumChildWindows(parent, enumChildCallback, 0)
    this.koffi.unregister(enumChildCallback)
    return children
  }

  private hasReadyComponents(children: Array<{ title: string; className: string }>): boolean {
    if (children.length === 0) return false

    const readyTexts = ['聊天', '登录', '账号']
    const readyClassMarkers = ['WeChat', 'Weixin', 'TXGuiFoundation', 'Qt5', 'ChatList', 'MainWnd', 'BrowserWnd', 'ListView']
    const readyChildCountThreshold = 14

    let classMatchCount = 0
    let titleMatchCount = 0
    let hasValidClassName = false

    for (const child of children) {
      const normalizedTitle = child.title.replace(/\s+/g, '')
      if (normalizedTitle) {
        if (readyTexts.some(marker => normalizedTitle.includes(marker))) {
          return true
        }
        titleMatchCount += 1
      }

      const className = child.className
      if (className) {
        if (readyClassMarkers.some(marker => className.includes(marker))) {
          return true
        }
        if (className.length > 5) {
          classMatchCount += 1
          hasValidClassName = true
        }
      }
    }

    if (classMatchCount >= 3 || titleMatchCount >= 2) return true
    if (children.length >= readyChildCountThreshold) return true
    if (hasValidClassName && children.length >= 5) return true
    return false
  }

  private async waitForWeChatWindowComponents(pid: number, timeoutMs = 15000): Promise<boolean> {
    if (!this.ensureUser32()) return true
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      let ready = false
      const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
        if (!this.IsWindowVisible(hWnd)) return true
        const title = this.getWindowTitle(hWnd)
        if (!this.isWeChatWindowTitle(title)) return true

        const pidBuf = Buffer.alloc(4)
        this.GetWindowThreadProcessId(hWnd, pidBuf)
        const windowPid = pidBuf.readUInt32LE(0)
        if (windowPid !== pid) return true

        const children = this.collectChildWindowInfos(hWnd)
        if (this.hasReadyComponents(children)) {
          ready = true
          return false
        }
        return true
      }, this.WNDENUMPROC_PTR)

      this.EnumWindows(enumWindowsCallback, 0)
      this.koffi.unregister(enumWindowsCallback)

      if (ready) return true
      await new Promise(r => setTimeout(r, 500))
    }
    return true
  }

  // --- Main Methods ---

  async autoGetDbKey(
    timeoutMs = 60_000,
    onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }
    if (!this.ensureLoaded()) return { success: false, error: 'wx_key.dll 未加载' }
    if (!this.ensureKernel32()) return { success: false, error: 'Kernel32 Init Failed' }

    const logs: string[] = []

    // 1. Find Path
    onStatus?.('正在定位微信安装路径...', 0)
    let wechatPath = await this.findWeChatInstallPath()
    if (!wechatPath) {
      const err = '未找到微信安装路径，请确认已安装PC微信'
      onStatus?.(err, 2)
      return { success: false, error: err }
    }

    // 2. Restart WeChat
    onStatus?.('正在重启微信以进行获取...', 0)
    await this.killWeChatProcesses()

    // 3. Launch
    onStatus?.('正在启动微信...', 0)
    const sub = spawn(wechatPath, { detached: true, stdio: 'ignore' })
    sub.unref()

    // 4. Wait for Window & Get PID (Crucial change: discover PID from window)
    onStatus?.('等待微信界面就绪...', 0)
    const pid = await this.waitForWeChatWindow()
    if (!pid) {
      return { success: false, error: '启动微信失败或等待界面就绪超时' }
    }

    onStatus?.(`检测到微信窗口 (PID: ${pid})，正在获取...`, 0)
    onStatus?.('正在检测微信界面组件...', 0)
    await this.waitForWeChatWindowComponents(pid, 15000)

    // 5. Inject
    const ok = this.initHook(pid)
    if (!ok) {
      const error = this.getLastErrorMsg ? this.decodeCString(this.getLastErrorMsg()) : ''
      if (error) {
        // 检测权限不足错误 (NTSTATUS 0xC0000022 = STATUS_ACCESS_DENIED)
        if (error.includes('0xC0000022') || error.includes('ACCESS_DENIED') || error.includes('打开目标进程失败')) {
          const friendlyError = '权限不足：无法访问微信进程。\n\n解决方法：\n1. 右键 WeFlow 图标，选择"以管理员身份运行"\n2. 关闭可能拦截的安全软件（如360、火绒等）\n3. 确保微信没有以管理员权限运行'
          return { success: false, error: friendlyError }
        }
        return { success: false, error }
      }
      const statusBuffer = Buffer.alloc(256)
      const levelOut = [0]
      const status = this.getStatusMessage && this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)
        ? this.decodeUtf8(statusBuffer)
        : ''
      return { success: false, error: status || '初始化失败' }
    }

    const keyBuffer = Buffer.alloc(128)
    const start = Date.now()

    try {
      while (Date.now() - start < timeoutMs) {
        if (this.pollKeyData(keyBuffer, keyBuffer.length)) {
          const key = this.decodeUtf8(keyBuffer)
          if (key.length === 64) {
            onStatus?.('密钥获取成功', 1)
            return { success: true, key, logs }
          }
        }

        for (let i = 0; i < 5; i++) {
          const statusBuffer = Buffer.alloc(256)
          const levelOut = [0]
          if (!this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)) {
            break
          }
          const msg = this.decodeUtf8(statusBuffer)
          const level = levelOut[0] ?? 0
          if (msg) {
            logs.push(msg)
            onStatus?.(msg, level)
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    } finally {
      try {
        this.cleanupHook()
      } catch { }
    }

    return { success: false, error: '获取密钥超时', logs }
  }

  // --- Image Key Stuff (Legacy but kept) ---

  private isAccountDir(dirPath: string): boolean {
    return (
      existsSync(join(dirPath, 'db_storage')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image2'))
    )
  }

  private isPotentialAccountName(name: string): boolean {
    const lower = name.toLowerCase()
    if (lower.startsWith('all') || lower.startsWith('applet') || lower.startsWith('backup') || lower.startsWith('wmpf')) {
      return false
    }
    if (lower.startsWith('wxid_')) return true
    if (/^\d+$/.test(name) && name.length >= 6) return true
    return name.length > 5
  }

  private listAccountDirs(rootDir: string): string[] {
    try {
      const entries = readdirSync(rootDir)
      const high: string[] = []
      const low: string[] = []
      for (const entry of entries) {
        const fullPath = join(rootDir, entry)
        try {
          if (!statSync(fullPath).isDirectory()) continue
        } catch {
          continue
        }

        if (!this.isPotentialAccountName(entry)) {
          continue
        }

        if (this.isAccountDir(fullPath)) {
          high.push(fullPath)
        } else {
          low.push(fullPath)
        }
      }
      return high.length ? high.sort() : low.sort()
    } catch {
      return []
    }
  }

  private normalizeExistingDir(inputPath: string): string | null {
    const trimmed = inputPath.replace(/[\\\\/]+$/, '')
    if (!existsSync(trimmed)) return null
    try {
      const stats = statSync(trimmed)
      if (stats.isFile()) {
        return dirname(trimmed)
      }
    } catch {
      return null
    }
    return trimmed
  }

  private resolveAccountDirFromPath(inputPath: string): string | null {
    const normalized = this.normalizeExistingDir(inputPath)
    if (!normalized) return null

    if (this.isAccountDir(normalized)) return normalized

    const lower = normalized.toLowerCase()
    if (lower.endsWith('db_storage') || lower.endsWith('filestorage') || lower.endsWith('image') || lower.endsWith('image2')) {
      const parent = dirname(normalized)
      if (this.isAccountDir(parent)) return parent
      const grandParent = dirname(parent)
      if (this.isAccountDir(grandParent)) return grandParent
    }

    const candidates = this.listAccountDirs(normalized)
    if (candidates.length) return candidates[0]
    return null
  }

  private resolveAccountDir(manualDir?: string): string | null {
    if (manualDir) {
      const resolved = this.resolveAccountDirFromPath(manualDir)
      if (resolved) return resolved
    }

    const userProfile = process.env.USERPROFILE
    if (!userProfile) return null
    const roots = [
      join(userProfile, 'Documents', 'xwechat_files'),
      join(userProfile, 'Documents', 'WeChat Files')
    ]
    for (const root of roots) {
      if (!existsSync(root)) continue
      const candidates = this.listAccountDirs(root)
      if (candidates.length) return candidates[0]
    }
    return null
  }

  private findTemplateDatFiles(rootDir: string): string[] {
    const files: string[] = []
    const stack = [rootDir]
    const maxFiles = 32
    while (stack.length && files.length < maxFiles) {
      const dir = stack.pop() as string
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        let stats: any
        try {
          stats = statSync(fullPath)
        } catch {
          continue
        }
        if (stats.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.endsWith('_t.dat')) {
          files.push(fullPath)
          if (files.length >= maxFiles) break
        }
      }
    }

    if (!files.length) return []
    const dateReg = /(\d{4}-\d{2})/
    files.sort((a, b) => {
      const ma = a.match(dateReg)?.[1]
      const mb = b.match(dateReg)?.[1]
      if (ma && mb) return mb.localeCompare(ma)
      return 0
    })
    return files.slice(0, 16)
  }

  private getXorKey(templateFiles: string[]): number | null {
    const counts = new Map<number, number>()
    const tailSignatures = [
      Buffer.from([0xFF, 0xD9]),
      Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])
    ]
    for (const file of templateFiles) {
      try {
        const bytes = readFileSync(file)
        for (const signature of tailSignatures) {
          if (bytes.length < signature.length) continue
          const tail = bytes.subarray(bytes.length - signature.length)
          const xorKey = tail[0] ^ signature[0]
          let valid = true
          for (let i = 1; i < signature.length; i++) {
            if ((tail[i] ^ xorKey) !== signature[i]) {
              valid = false
              break
            }
          }
          if (valid) {
            counts.set(xorKey, (counts.get(xorKey) ?? 0) + 1)
          }
        }
      } catch { }
    }
    if (!counts.size) return null
    let bestKey: number | null = null
    let bestCount = 0
    for (const [key, count] of counts) {
      if (count > bestCount) {
        bestCount = count
        bestKey = key
      }
    }
    return bestKey
  }

  private getCiphertextFromTemplate(templateFiles: string[]): Buffer | null {
    for (const file of templateFiles) {
      try {
        const bytes = readFileSync(file)
        if (bytes.length < 0x1f) continue
        if (
          bytes[0] === 0x07 &&
          bytes[1] === 0x08 &&
          bytes[2] === 0x56 &&
          bytes[3] === 0x32 &&
          bytes[4] === 0x08 &&
          bytes[5] === 0x07
        ) {
          return bytes.subarray(0x0f, 0x1f)
        }
      } catch { }
    }
    return null
  }

  private isAlphaNumLower(byte: number): boolean {
    // 只匹配小写字母 a-z 和数字 0-9（AES密钥格式）
    return (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
  }

  private isUtf16LowerKey(buf: Buffer, start: number): boolean {
    if (start + 64 > buf.length) return false
    for (let j = 0; j < 32; j++) {
      const charByte = buf[start + j * 2]
      const nullByte = buf[start + j * 2 + 1]
      if (nullByte !== 0x00 || !this.isAlphaNumLower(charByte)) {
        return false
      }
    }
    return true
  }

  private verifyKey(ciphertext: Buffer, keyBytes: Buffer): boolean {
    try {
      const key = keyBytes.subarray(0, 16)
      const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const isJpeg = decrypted.length >= 3 && decrypted[0] === 0xff && decrypted[1] === 0xd8 && decrypted[2] === 0xff
      const isPng = decrypted.length >= 8 &&
        decrypted[0] === 0x89 &&
        decrypted[1] === 0x50 &&
        decrypted[2] === 0x4e &&
        decrypted[3] === 0x47 &&
        decrypted[4] === 0x0d &&
        decrypted[5] === 0x0a &&
        decrypted[6] === 0x1a &&
        decrypted[7] === 0x0a
      return isJpeg || isPng
    } catch {
      return false
    }
  }

  private getMemoryRegions(hProcess: any): Array<[number, number]> {
    const regions: Array<[number, number]> = []
    const MEM_COMMIT = 0x1000
    const MEM_PRIVATE = 0x20000
    const PAGE_NOACCESS = 0x01
    const PAGE_GUARD = 0x100

    let address = 0
    const maxAddress = 0x7fffffffffff
    while (address >= 0 && address < maxAddress) {
      const info: any = {}
      const result = this.VirtualQueryEx(hProcess, address, info, this.koffi.sizeof(this.MEMORY_BASIC_INFORMATION))
      if (!result) break

      const state = info.State
      const protect = info.Protect
      const type = info.Type
      const regionSize = Number(info.RegionSize)
      // 只收集已提交的私有内存（大幅减少扫描区域）
      if (state === MEM_COMMIT && type === MEM_PRIVATE && (protect & PAGE_NOACCESS) === 0 && (protect & PAGE_GUARD) === 0) {
        regions.push([Number(info.BaseAddress), regionSize])
      }

      const nextAddress = address + regionSize
      if (nextAddress <= address) break
      address = nextAddress
    }
    return regions
  }

  private readProcessMemory(hProcess: any, address: number, size: number): Buffer | null {
    const buffer = Buffer.alloc(size)
    const bytesRead = [0]
    const ok = this.ReadProcessMemory(hProcess, address, buffer, size, bytesRead)
    if (!ok || bytesRead[0] === 0) return null
    return buffer.subarray(0, bytesRead[0])
  }

  private async getAesKeyFromMemory(
    pid: number,
    ciphertext: Buffer,
    onProgress?: (current: number, total: number, message: string) => void
  ): Promise<string | null> {
    if (!this.ensureKernel32()) return null
    const hProcess = this.OpenProcess(this.PROCESS_ALL_ACCESS, false, pid)
    if (!hProcess) return null

    try {
      const allRegions = this.getMemoryRegions(hProcess)
      const totalRegions = allRegions.length
      let scannedCount = 0
      let skippedCount = 0

      for (const [baseAddress, regionSize] of allRegions) {
        // 跳过太大的内存区域（> 100MB）
        if (regionSize > 100 * 1024 * 1024) {
          skippedCount++
          continue
        }

        scannedCount++
        if (scannedCount % 10 === 0) {
          onProgress?.(scannedCount, totalRegions, `正在扫描微信内存... (${scannedCount}/${totalRegions})`)
          await new Promise(resolve => setImmediate(resolve))
        }

        const memory = this.readProcessMemory(hProcess, baseAddress, regionSize)
        if (!memory) continue

        // 直接在原始字节中搜索32字节的小写字母数字序列
        for (let i = 0; i < memory.length - 34; i++) {
          // 检查前导字符（不是小写字母或数字）
          if (this.isAlphaNumLower(memory[i])) continue

          // 检查接下来32个字节是否都是小写字母或数字
          let valid = true
          for (let j = 1; j <= 32; j++) {
            if (!this.isAlphaNumLower(memory[i + j])) {
              valid = false
              break
            }
          }
          if (!valid) continue

          // 检查尾部字符（不是小写字母或数字）
          if (i + 33 < memory.length && this.isAlphaNumLower(memory[i + 33])) {
            continue
          }

          const keyBytes = memory.subarray(i + 1, i + 33)
          if (this.verifyKey(ciphertext, keyBytes)) {
            return keyBytes.toString('ascii')
          }
        }
      }
      return null
    } finally {
      try {
        this.CloseHandle(hProcess)
      } catch { }
    }
  }

  async autoGetImageKey(
    manualDir?: string,
    onProgress?: (message: string) => void
  ): Promise<ImageKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }
    if (!this.ensureLoaded()) return { success: false, error: 'wx_key.dll 未加载' }
    if (!this.ensureKernel32()) return { success: false, error: '初始化系统 API 失败' }

    onProgress?.('正在定位微信账号目录...')
    const accountDir = this.resolveAccountDir(manualDir)
    if (!accountDir) return { success: false, error: '未找到微信账号目录' }

    onProgress?.('正在收集模板文件...')
    const templateFiles = this.findTemplateDatFiles(accountDir)
    if (!templateFiles.length) return { success: false, error: '未找到模板文件' }

    onProgress?.('正在计算 XOR 密钥...')
    const xorKey = this.getXorKey(templateFiles)
    if (xorKey == null) return { success: false, error: '无法计算 XOR 密钥' }

    onProgress?.('正在读取加密模板数据...')
    const ciphertext = this.getCiphertextFromTemplate(templateFiles)
    if (!ciphertext) return { success: false, error: '无法读取加密模板数据' }

    const pid = await this.findWeChatPid()
    if (!pid) return { success: false, error: '未检测到微信进程' }

    onProgress?.('正在扫描内存获取 AES 密钥...')
    const aesKey = await this.getAesKeyFromMemory(pid, ciphertext, (current, total, msg) => {
      onProgress?.(`${msg} (${current}/${total})`)
    })
    if (!aesKey) {
      return {
        success: false,
        error: '未能从内存中获取 AES 密钥，请打开朋友圈图片后重试'
      }
    }

    return { success: true, xorKey, aesKey: aesKey.slice(0, 16) }
  }
}
