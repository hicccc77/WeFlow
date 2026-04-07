import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync, copyFileSync, mkdirSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import crypto from 'crypto'

const execFileAsync = promisify(execFile)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; error?: string }

export class KeyService {
  private readonly isMac = process.platform === 'darwin'
  private koffi: any = null
  private lib: any = null
  private initialized = false
  private initHook: any = null
  private pollKeyData: any = null
  private getStatusMessage: any = null
  private cleanupHook: any = null
  private getLastErrorMsg: any = null
  private getImageKeyDll: any = null

  // Win32 APIs
  private kernel32: any = null
  private user32: any = null
  private advapi32: any = null

  // Kernel32
  private OpenProcess: any = null
  private CloseHandle: any = null
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
  private PostMessageW: any = null
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
  private readonly WM_CLOSE = 0x0010

  private getDllPath(): string {
    const isPackaged = typeof app !== 'undefined' && app ? app.isPackaged : process.env.NODE_ENV === 'production'
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const candidates: string[] = []

    if (process.env.WX_KEY_DLL_PATH) {
      candidates.push(process.env.WX_KEY_DLL_PATH)
    }

    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'win32', archDir, 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'win32', 'x64', 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'win32', 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'resources', 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'wx_key.dll'))
    } else {
      const cwd = process.cwd()
      candidates.push(join(cwd, 'resources', 'key', 'win32', archDir, 'wx_key.dll'))
      candidates.push(join(cwd, 'resources', 'key', 'win32', 'x64', 'wx_key.dll'))
      candidates.push(join(cwd, 'resources', 'key', 'win32', 'wx_key.dll'))
      candidates.push(join(cwd, 'resources', 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'win32', archDir, 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'win32', 'x64', 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'win32', 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'wx_key.dll'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    return candidates[0]
  }

  private isNetworkPath(path: string): boolean {
    if (path.startsWith('\\\\')) return true
    return false
  }

  private localizeNetworkDll(originalPath: string): string {
    try {
      const tempDir = join(os.tmpdir(), 'weflow_dll_cache')
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true })
      }
      const localPath = join(tempDir, 'wx_key.dll')
      if (existsSync(localPath)) return localPath

      copyFileSync(originalPath, localPath)
      return localPath
    } catch (e) {
      console.error('DLL 本地化失败:', e)
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

      if (this.isNetworkPath(dllPath)) {
        dllPath = this.localizeNetworkDll(dllPath)
      }

      this.lib = this.koffi.load(dllPath)
      this.initHook = this.lib.func('bool InitializeHook(uint32 targetPid)')
      this.pollKeyData = this.lib.func('bool PollKeyData(_Out_ char *keyBuffer, int bufferSize)')
      this.getStatusMessage = this.lib.func('bool GetStatusMessage(_Out_ char *msgBuffer, int bufferSize, _Out_ int *outLevel)')
      this.cleanupHook = this.lib.func('bool CleanupHook()')
      this.getLastErrorMsg = this.lib.func('const char* GetLastErrorMsg()')
      this.getImageKeyDll = this.lib.func('bool GetImageKey(_Out_ char *resultBuffer, int bufferSize)')

      this.initialized = true
      return true
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      console.error(`加载 wx_key.dll 失败\n  路径: ${dllPath}\n  错误: ${errorMsg}`)
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
      this.OpenProcess = this.kernel32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32'])
      this.CloseHandle = this.kernel32.func('CloseHandle', 'bool', ['void*'])
      this.TerminateProcess = this.kernel32.func('TerminateProcess', 'bool', ['void*', 'uint32'])
      this.QueryFullProcessImageNameW = this.kernel32.func('QueryFullProcessImageNameW', 'bool', ['void*', 'uint32', this.koffi.out('uint16*'), this.koffi.out('uint32*')])

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

      const WNDENUMPROC = this.koffi.proto('bool __stdcall (void *hWnd, intptr_t lParam)')
      this.WNDENUMPROC_PTR = this.koffi.pointer(WNDENUMPROC)

      this.EnumWindows = this.user32.func('EnumWindows', 'bool', [this.WNDENUMPROC_PTR, 'intptr_t'])
      this.EnumChildWindows = this.user32.func('EnumChildWindows', 'bool', ['void*', this.WNDENUMPROC_PTR, 'intptr_t'])
      this.PostMessageW = this.user32.func('PostMessageW', 'bool', ['void*', 'uint32', 'uintptr_t', 'intptr_t'])
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

  private readRegistryString(rootKey: number, subKey: string, valueName: string): string | null {
    if (!this.ensureAdvapi32()) return null
    const subKeyBuf = Buffer.from(subKey + '\0', 'ucs2')
    const valueNameBuf = valueName ? Buffer.from(valueName + '\0', 'ucs2') : null
    const phkResult = Buffer.alloc(8)

    if (this.RegOpenKeyExW(rootKey, subKeyBuf, 0, this.KEY_READ, phkResult) !== this.ERROR_SUCCESS) return null

    const hKey = this.koffi.decode(phkResult, 'uintptr_t')

    try {
      const lpcbData = Buffer.alloc(4)
      lpcbData.writeUInt32LE(0, 0)

      let ret = this.RegQueryValueExW(hKey, valueNameBuf, null, null, null, lpcbData)
      if (ret !== this.ERROR_SUCCESS) return null

      const size = lpcbData.readUInt32LE(0)
      if (size === 0) return null

      const dataBuf = Buffer.alloc(size)
      ret = this.RegQueryValueExW(hKey, valueNameBuf, null, null, dataBuf, lpcbData)
      if (ret !== this.ERROR_SUCCESS) return null

      let str = dataBuf.toString('ucs2')
      if (str.endsWith('\0')) str = str.slice(0, -1)
      return str
    } finally {
      this.RegCloseKey(hKey)
    }
  }

  private async getProcessExecutablePath(pid: number): Promise<string | null> {
    if (!this.ensureKernel32()) return null
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
    try {
      const pid = await this.findWeChatPid()
      if (pid) {
        const runPath = await this.getProcessExecutablePath(pid)
        if (runPath && existsSync(runPath)) return runPath
      }
    } catch (e) {
      console.error('尝试获取运行中微信路径失败:', e)
    }

    const uninstallKeys = [
      'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ]
    const roots = [this.HKEY_LOCAL_MACHINE, this.HKEY_CURRENT_USER]
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

    for (const root of roots) {
      for (const parent of uninstallKeys) {
        const path = this.readRegistryString(root, parent + '\\WeChat', 'InstallLocation')
        if (path && existsSync(join(path, 'Weixin.exe'))) return join(path, 'Weixin.exe')
      }
    }

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

  private async waitForWeChatExit(timeoutMs = 8000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const weixinPid = await this.findPidByImageName('Weixin.exe')
      const wechatPid = await this.findPidByImageName('WeChat.exe')
      if (!weixinPid && !wechatPid) return true
      await new Promise(r => setTimeout(r, 400))
    }
    return false
  }

  private async closeWeChatWindows(): Promise<boolean> {
    if (!this.ensureUser32()) return false
    let requested = false

    const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
      if (!this.IsWindowVisible(hWnd)) return true
      const title = this.getWindowTitle(hWnd)
      const className = this.getClassName(hWnd)
      const classLower = (className || '').toLowerCase()
      const isWeChatWindow = this.isWeChatWindowTitle(title) || classLower.includes('wechat') || classLower.includes('weixin')
      if (!isWeChatWindow) return true

      requested = true
      try {
        this.PostMessageW?.(hWnd, this.WM_CLOSE, 0, 0)
      } catch { }
      return true
    }, this.WNDENUMPROC_PTR)

    this.EnumWindows(enumWindowsCallback, 0)
    this.koffi.unregister(enumWindowsCallback)

    return requested
  }

  private async killWeChatProcesses(): Promise<boolean> {
    const requested = await this.closeWeChatWindows()
    if (requested) {
      const gracefulOk = await this.waitForWeChatExit(1500)
      if (gracefulOk) return true
    }

    try {
      await execFileAsync('taskkill', ['/F', '/T', '/IM', 'Weixin.exe'])
      await execFileAsync('taskkill', ['/F', '/T', '/IM', 'WeChat.exe'])
    } catch (e) { }

    return await this.waitForWeChatExit(5000)
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
        if (readyTexts.some(marker => normalizedTitle.includes(marker))) return true
        titleMatchCount += 1
      }
      const className = child.className
      if (className) {
        if (readyClassMarkers.some(marker => className.includes(marker))) return true
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

  private isLoginRelatedText(value: string): boolean {
    const normalized = String(value || '').replace(/\s+/g, '').toLowerCase()
    if (!normalized) return false
    const keywords = [
      '登录',
      '扫码',
      '二维码',
      '请在手机上确认',
      '手机确认',
      '切换账号',
      'wechatlogin',
      'qrcode',
      'scan'
    ]
    return keywords.some((keyword) => normalized.includes(keyword))
  }

  private async detectWeChatLoginRequired(pid: number): Promise<boolean> {
    if (!this.ensureUser32()) return false
    let loginRequired = false

    const enumWindowsCallback = this.koffi.register((hWnd: any, _lParam: any) => {
      if (!this.IsWindowVisible(hWnd)) return true
      const title = this.getWindowTitle(hWnd)
      if (!this.isWeChatWindowTitle(title)) return true

      const pidBuf = Buffer.alloc(4)
      this.GetWindowThreadProcessId(hWnd, pidBuf)
      const windowPid = pidBuf.readUInt32LE(0)
      if (windowPid !== pid) return true

      if (this.isLoginRelatedText(title)) {
        loginRequired = true
        return false
      }

      const children = this.collectChildWindowInfos(hWnd)
      for (const child of children) {
        if (this.isLoginRelatedText(child.title) || this.isLoginRelatedText(child.className)) {
          loginRequired = true
          return false
        }
      }
      return true
    }, this.WNDENUMPROC_PTR)

    this.EnumWindows(enumWindowsCallback, 0)
    this.koffi.unregister(enumWindowsCallback)

    return loginRequired
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

  // --- DB Key Logic (Unchanged core flow) ---

  async autoGetDbKey(
      timeoutMs = 60_000,
      onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }
    if (!this.ensureLoaded()) return { success: false, error: 'wx_key.dll 未加载' }
    if (!this.ensureKernel32()) return { success: false, error: 'Kernel32 Init Failed' }

    const logs: string[] = []

    onStatus?.('正在查找微信进程...', 0)
    const pid = await this.findWeChatPid()
    if (!pid) {
      const err = '未找到微信进程，请先启动微信'
      onStatus?.(err, 2)
      return { success: false, error: err }
    }

    onStatus?.(`检测到微信窗口 (PID: ${pid})，正在获取...`, 0)
    onStatus?.('正在检测微信界面组件...', 0)
    await this.waitForWeChatWindowComponents(pid, 15000)

    const ok = this.initHook(pid)
    if (!ok) {
      const error = this.getLastErrorMsg ? this.decodeCString(this.getLastErrorMsg()) : ''
      if (error) {
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
    let loginRequiredDetected = false

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
          if (!this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)) break
          const msg = this.decodeUtf8(statusBuffer)
          const level = levelOut[0] ?? 0
          if (msg) {
            logs.push(msg)
            if (this.isLoginRelatedText(msg)) {
              loginRequiredDetected = true
            }
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

    const loginRequired = loginRequiredDetected || await this.detectWeChatLoginRequired(pid)
    if (loginRequired) {
      return {
        success: false,
        error: '微信已启动但尚未完成登录，请先在微信客户端完成登录后再重试自动获取密钥。',
        logs
      }
    }

    return { success: false, error: '获取密钥超时', logs }
  }

  private cleanWxid(wxid: string): string {
    const first = wxid.indexOf('_')
    if (first === -1) return wxid
    const second = wxid.indexOf('_', first + 1)
    if (second === -1) return wxid
    return wxid.substring(0, second)
  }

  private deriveImageKeys(code: number, wxid: string): { xorKey: number; aesKey: string } {
    const cleanedWxid = this.cleanWxid(wxid)
    const xorKey = code & 0xFF
    const dataToHash = code.toString() + cleanedWxid
    const md5Full = crypto.createHash('md5').update(dataToHash).digest('hex')
    const aesKey = md5Full.substring(0, 16)
    return { xorKey, aesKey }
  }

  private verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
    try {
      if (!aesKey || aesKey.length < 16 || ciphertext.length !== 16) return false
      const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii').subarray(0, 16), null)
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

  private async collectWxidCandidates(manualDir?: string, wxidParam?: string): Promise<string[]> {
    const candidates: string[] = []
    const pushUnique = (value: string) => {
      const v = String(value || '').trim()
      if (!v || candidates.includes(v)) return
      candidates.push(v)
    }

    if (wxidParam && wxidParam.startsWith('wxid_')) pushUnique(wxidParam)

    if (manualDir) {
      const normalized = manualDir.replace(/[\\/]+$/, '')
      const dirName = normalized.split(/[\\/]/).pop() ?? ''
      if (dirName.startsWith('wxid_')) pushUnique(dirName)

      const marker = normalized.match(/[\\/]xwechat_files/i) || normalized.match(/[\\/]WeChat Files/i)
      if (marker) {
        const root = normalized.slice(0, marker.index! + marker[0].length)
        try {
          const { readdirSync, statSync } = await import('fs')
          const { join } = await import('path')
          for (const entry of readdirSync(root)) {
            if (!entry.startsWith('wxid_')) continue
            const full = join(root, entry)
            try {
              if (statSync(full).isDirectory()) pushUnique(entry)
            } catch { }
          }
        } catch { }
      }
    }

    pushUnique('unknown')
    return candidates
  }

  async autoGetImageKey(
      manualDir?: string,
      onProgress?: (message: string) => void,
      wxidParam?: string
  ): Promise<ImageKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }
    if (!this.ensureLoaded()) return { success: false, error: 'wx_key.dll 未加载' }

    onProgress?.('正在从缓存目录扫描图片密钥...')

    const resultBuffer = Buffer.alloc(8192)
    const ok = this.getImageKeyDll(resultBuffer, resultBuffer.length)

    if (!ok) {
      const errMsg = this.getLastErrorMsg ? this.decodeCString(this.getLastErrorMsg()) : '获取图片密钥失败'
      return { success: false, error: errMsg }
    }

    const jsonStr = this.decodeUtf8(resultBuffer)
    let parsed: any
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      return { success: false, error: '解析密钥数据失败' }
    }

    // 从任意账号提取 code 列表（code 来自 kvcomm，与 wxid 无关，所有账号都一样）
    const accounts: any[] = parsed.accounts ?? []
    if (!accounts.length || !accounts[0]?.keys?.length) {
      return { success: false, error: '未找到有效的密钥码（kvcomm 缓存为空）' }
    }

    const codes: number[] = accounts[0].keys.map((k: any) => k.code)
    console.log('[ImageKey] codes:', codes, 'DLL wxids:', accounts.map((a: any) => a.wxid))

    const wxidCandidates = await this.collectWxidCandidates(manualDir, wxidParam)
    let verifyCiphertext: Buffer | null = null
    if (manualDir && existsSync(manualDir)) {
      const template = await this._findTemplateData(manualDir, 32)
      verifyCiphertext = template.ciphertext
    }

    if (verifyCiphertext) {
      onProgress?.(`正在校验候选 wxid（${wxidCandidates.length} 个）...`)
      for (const candidateWxid of wxidCandidates) {
        for (const code of codes) {
          const { xorKey, aesKey } = this.deriveImageKeys(code, candidateWxid)
          if (!this.verifyDerivedAesKey(aesKey, verifyCiphertext)) continue
          onProgress?.(`密钥获取成功 (wxid: ${candidateWxid}, code: ${code})`)
          console.log('[ImageKey] 校验命中: wxid=', candidateWxid, 'code=', code)
          return { success: true, xorKey, aesKey }
        }
      }
      return { success: false, error: '缓存 code 与当前账号 wxid 未匹配，请确认账号目录后重试，或使用内存扫描' }
    }

    // 无模板密文可验真时回退旧策略
    const fallbackWxid = wxidCandidates[0] || accounts[0].wxid || 'unknown'
    const fallbackCode = codes[0]
    const { xorKey, aesKey } = this.deriveImageKeys(fallbackCode, fallbackWxid)
    onProgress?.(`密钥获取成功 (wxid: ${fallbackWxid}, code: ${fallbackCode})`)
    console.log('[ImageKey] 回退计算: wxid=', fallbackWxid, 'code=', fallbackCode)
    return { success: true, xorKey, aesKey }
  }

  // --- 内存扫描备选方案（融合 Dart+Python 优点）---
  // 只扫 RW 可写区域（更快），同时支持 ASCII 和 UTF-16LE 两种密钥格式
  // 验证支持 JPEG/PNG/WEBP/WXGF/GIF 多种格式

  async autoGetImageKeyByMemoryScan(
    userDir: string,
    onProgress?: (message: string) => void
  ): Promise<ImageKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }

    try {
      // 1. 查找模板文件获取密文和 XOR 密钥
      onProgress?.('正在查找模板文件...')
      let result = await this._findTemplateData(userDir, 32)
      let { ciphertext, xorKey } = result
      
      // 如果找不到密钥，尝试扫描更多文件
      if (ciphertext && xorKey === null) {
        onProgress?.('未找到有效密钥，尝试扫描更多文件...')
        result = await this._findTemplateData(userDir, 100)
        xorKey = result.xorKey
      }
      
      if (!ciphertext) return { success: false, error: '未找到 V2 模板文件，请先在微信中查看几张图片' }
      if (xorKey === null) return { success: false, error: '未能从模板文件中计算出有效的 XOR 密钥，请确保在微信中查看了多张不同的图片' }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      // 2. 找微信 PID
      const pid = await this.findWeChatPid()
      if (!pid) return { success: false, error: '微信进程未运行，请先启动微信' }

      onProgress?.(`已找到微信进程 PID=${pid}，正在扫描内存...`)

      // 3. 持续轮询内存扫描，最多 60 秒
      const deadline = Date.now() + 60_000
      let scanCount = 0
      while (Date.now() < deadline) {
        scanCount++
        onProgress?.(`第 ${scanCount} 次扫描内存，请在微信中打开图片大图...`)
        const aesKey = await this._scanMemoryForAesKey(pid, ciphertext, onProgress)
        if (aesKey) {
          onProgress?.('密钥获取成功')
          return { success: true, xorKey, aesKey }
        }
        // 等 5 秒再试
        await new Promise(r => setTimeout(r, 5000))
      }

      return {
        success: false,
        error: '60 秒内未找到 AES 密钥。\n请确保已在微信中打开 2-3 张图片大图后再试。'
      }
    } catch (e) {
      return { success: false, error: `内存扫描失败: ${e}` }
    }
  }

  private async _findTemplateData(userDir: string, limit: number = 32): Promise<{ ciphertext: Buffer | null; xorKey: number | null }> {
    const { readdirSync, readFileSync, statSync } = await import('fs')
    const { join } = await import('path')
    const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

    // 递归收集 *_t.dat 文件
    const collect = (dir: string, results: string[], maxFiles: number) => {
      if (results.length >= maxFiles) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) break
          const full = join(dir, entry.name)
          if (entry.isDirectory()) collect(full, results, maxFiles)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) results.push(full)
        }
      } catch { /* 忽略无权限目录 */ }
    }

    const files: string[] = []
    collect(userDir, files, limit)

    // 按修改时间降序
    files.sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
    })

    let ciphertext: Buffer | null = null
    const tailCounts: Record<string, number> = {}

    for (const f of files.slice(0, 32)) {
      try {
        const data = readFileSync(f)
        if (data.length < 8) continue

        // 统计末尾两字节用于 XOR 密钥
        if (data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 2) {
          const key = `${data[data.length - 2]}_${data[data.length - 1]}`
          tailCounts[key] = (tailCounts[key] ?? 0) + 1
        }

        // 提取密文（取第一个有效的）
        if (!ciphertext && data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 0x1F) {
          ciphertext = data.subarray(0xF, 0x1F)
        }
      } catch { /* 忽略 */ }
    }

    // 计算 XOR 密钥
    let xorKey: number | null = null
    let maxCount = 0
    for (const [key, count] of Object.entries(tailCounts)) {
      if (count > maxCount) { maxCount = count; const [x, y] = key.split('_').map(Number); const k = x ^ 0xFF; if (k === (y ^ 0xD9)) xorKey = k }
    }

    return { ciphertext, xorKey }
  }

  private async _scanMemoryForAesKey(
    pid: number,
    ciphertext: Buffer,
    onProgress?: (msg: string) => void
  ): Promise<string | null> {
    if (!this.ensureKernel32()) return null

    // 直接用已加载的 kernel32 实例，用 uintptr 传地址
    const VirtualQueryEx = this.kernel32.func('VirtualQueryEx', 'size_t', ['void*', 'uintptr', 'void*', 'size_t'])
    const ReadProcessMemory = this.kernel32.func('ReadProcessMemory', 'bool', ['void*', 'uintptr', 'void*', 'size_t', this.koffi.out('size_t*')])

    // RW 保护标志（只扫可写区域，速度更快）
    const RW_FLAGS = 0x04 | 0x08 | 0x40 | 0x80 // PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY
    const MEM_COMMIT = 0x1000
    const PAGE_NOACCESS = 0x01
    const PAGE_GUARD = 0x100
    const MBI_SIZE = 48 // MEMORY_BASIC_INFORMATION size on x64

    const hProcess = this.OpenProcess(0x1F0FFF, false, pid)
    if (!hProcess) return null

    try {
      // 枚举 RW 内存区域
      const regions: Array<[number, number]> = []
      let addr = 0
      const mbi = Buffer.alloc(MBI_SIZE)

      while (addr < 0x7FFFFFFFFFFF) {
        const ret = VirtualQueryEx(hProcess, addr, mbi, MBI_SIZE)
        if (ret === 0) break
        // MEMORY_BASIC_INFORMATION x64 布局:
        // 0:  BaseAddress (8)
        // 8:  AllocationBase (8)
        // 16: AllocationProtect (4) + 4 padding
        // 24: RegionSize (8)
        // 32: State (4)
        // 36: Protect (4)
        // 40: Type (4) + 4 padding = 48 total
        const base = Number(mbi.readBigUInt64LE(0))
        const size = Number(mbi.readBigUInt64LE(24))
        const state = mbi.readUInt32LE(32)
        const protect = mbi.readUInt32LE(36)

        if (state === MEM_COMMIT &&
            protect !== PAGE_NOACCESS &&
            (protect & PAGE_GUARD) === 0 &&
            (protect & RW_FLAGS) !== 0 &&
            size <= 50 * 1024 * 1024) {
          regions.push([base, size])
        }
        const next = base + size
        if (next <= addr) break
        addr = next
      }

      const totalMB = regions.reduce((s, [, sz]) => s + sz, 0) / 1024 / 1024
      onProgress?.(`扫描 ${regions.length} 个 RW 区域 (${totalMB.toFixed(0)} MB)...`)

      const CHUNK = 4 * 1024 * 1024
      const OVERLAP = 65

      for (let i = 0; i < regions.length; i++) {
        const [base, size] = regions[i]
        if (i % 20 === 0) {
          onProgress?.(`扫描进度 ${i}/${regions.length}...`)
          await new Promise(r => setTimeout(r, 1)) // 让出事件循环
        }

        let offset = 0
        let trailing: Buffer | null = null

        while (offset < size) {
          const chunkSize = Math.min(CHUNK, size - offset)
          const buf = Buffer.alloc(chunkSize)
          const bytesReadOut = [0]
          const ok = ReadProcessMemory(hProcess, base + offset, buf, chunkSize, bytesReadOut)
          if (!ok || bytesReadOut[0] === 0) { offset += chunkSize; trailing = null; continue }

          const data: Buffer = trailing ? Buffer.concat([trailing, buf.subarray(0, bytesReadOut[0])]) : buf.subarray(0, bytesReadOut[0])

          // 搜索 ASCII 32字节密钥
          const key = this._searchAsciiKey(data, ciphertext)
          if (key) { this.CloseHandle(hProcess); return key }

          // 搜索 UTF-16LE 32字节密钥
          const key16 = this._searchUtf16Key(data, ciphertext)
          if (key16) { this.CloseHandle(hProcess); return key16 }

          trailing = data.subarray(Math.max(0, data.length - OVERLAP))
          offset += chunkSize
        }
      }

      return null
    } finally {
      this.CloseHandle(hProcess)
    }
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
      // 支持 JPEG / PNG / WEBP / WXGF / GIF
      if (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) return true
      if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) return true
      if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return true
      if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return true
      if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return true
      return false
    } catch { return false }
  }
}
