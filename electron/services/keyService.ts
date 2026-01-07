import { app } from 'electron'
import { join, dirname, basename } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'

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
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    return join(resourcesPath, 'wx_key.dll')
  }

  private ensureLoaded(): boolean {
    if (this.initialized) return true
    try {
      this.koffi = require('koffi')
      const dllPath = this.getDllPath()
      if (!existsSync(dllPath)) return false

      this.lib = this.koffi.load(dllPath)
      this.initHook = this.lib.func('bool InitializeHook(uint32 targetPid)')
      this.pollKeyData = this.lib.func('bool PollKeyData(_Out_ char *keyBuffer, int bufferSize)')
      this.getStatusMessage = this.lib.func('bool GetStatusMessage(_Out_ char *msgBuffer, int bufferSize, _Out_ int *outLevel)')
      this.cleanupHook = this.lib.func('bool CleanupHook()')
      this.getLastErrorMsg = this.lib.func('const char* GetLastErrorMsg()')

      this.initialized = true
      return true
    } catch (e) {
      console.error('加载 wx_key.dll 失败:', e)
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

  private async findWeChatInstallPath(): Promise<string | null> {
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

  private async findWeChatPid(): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'])
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      for (const line of lines) {
        if (line.startsWith('INFO:')) continue
        const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
        if (parts[0]?.toLowerCase() === 'weixin.exe') {
          const pid = Number(parts[1])
          if (!Number.isNaN(pid)) return pid
        }
      }
      return null
    } catch (e) {
      console.error('获取微信进程失败:', e)
      return null
    }
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

  private async waitForWeChatWindowReady(timeoutMs = 25000): Promise<number | null> {
    if (!this.ensureUser32()) return null

    const startTime = Date.now()
    const readyComponents = ['登录', '聊天', '账号', '进入微信']
    const readyClasses = ['WeChat', 'Weixin', 'TXGuiFoundation', 'Qt5', 'ChatList', 'MainWnd']

    while (Date.now() - startTime < timeoutMs) {
      let foundPid: number | null = null

      const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
        if (!this.IsWindowVisible(hWnd)) return true

        const title = this.getWindowTitle(hWnd)
        // Match contains logic from wx_key
        if (title.includes('微信') || title.includes('Weixin') || title.toLowerCase().includes('wechat')) {
          const pidBuf = Buffer.alloc(4)
          this.GetWindowThreadProcessId(hWnd, pidBuf)
          const pid = pidBuf.readUInt32LE(0)

          // Enum children to check if it's "ready" (but be lenient like wx_key)
          let childCount = 0
          let matchedComponent = false

          const enumChildCallback = this.koffi.register((hChild: any, lp: any) => {
            childCount++
            const childTitle = this.getWindowTitle(hChild)
            const childClass = this.getClassName(hChild)
            if (readyComponents.some(c => childTitle.includes(c))) matchedComponent = true
            if (readyClasses.some(c => childClass.includes(c))) matchedComponent = true
            return !matchedComponent // stop if found
          }, this.WNDENUMPROC_PTR)

          this.EnumChildWindows(hWnd, enumChildCallback, 0)
          this.koffi.unregister(enumChildCallback)

          // Lenient condition matching wx_key's fallback logic
          // If we found any component OR class OR just a reasonable amount of children
          if (matchedComponent || childCount >= 5 || childCount === 0) {
            foundPid = pid
            return false // Stop enumeration
          }
        }
        return true
      }, this.WNDENUMPROC_PTR)

      this.EnumWindows(enumWindowsCallback, 0)
      this.koffi.unregister(enumWindowsCallback)

      if (foundPid) return foundPid
      await new Promise(r => setTimeout(r, 1000))
    }

    return null
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
    const pid = await this.waitForWeChatWindowReady()
    if (!pid) {
      return { success: false, error: '启动微信失败或等待界面就绪超时' }
    }

    onStatus?.(`检测到微信窗口 (PID: ${pid})，正在获取...`, 0)

    // 5. Inject
    const ok = this.initHook(pid)
    if (!ok) {
      const error = this.getLastErrorMsg ? this.decodeCString(this.getLastErrorMsg()) : '初始化失败'
      return { success: false, error }
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

        const lower = entry.toLowerCase()
        if (lower.startsWith('all') || lower.startsWith('applet') || lower.startsWith('backup') || lower.startsWith('wmpf')) {
          continue
        }
        if (!entry.startsWith('wxid_') && entry.length <= 5) {
          continue
        }

        const hasDb = existsSync(join(fullPath, 'db_storage'))
        const hasImage = existsSync(join(fullPath, 'FileStorage', 'Image'))
        if (hasDb || hasImage) {
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

  private resolveAccountDir(manualDir?: string): string | null {
    if (manualDir && existsSync(manualDir)) {
      const normalized = manualDir.replace(/[\\\\/]+$/, '')
      if (existsSync(join(normalized, 'FileStorage', 'Image')) || existsSync(join(normalized, 'db_storage'))) {
        return normalized
      }
      const candidates = this.listAccountDirs(normalized)
      if (candidates.length) return candidates[0]
    }

    const userProfile = process.env.USERPROFILE
    if (!userProfile) return null
    const wechatRoot = join(userProfile, 'Documents', 'xwechat_files')
    if (!existsSync(wechatRoot)) return null
    const candidates = this.listAccountDirs(wechatRoot)
    return candidates[0] ?? null
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
    const counts = new Map<string, number>()
    for (const file of templateFiles) {
      try {
        const bytes = readFileSync(file)
        if (bytes.length < 2) continue
        const x = bytes[bytes.length - 2]
        const y = bytes[bytes.length - 1]
        const key = `${x}_${y}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      } catch { }
    }
    if (!counts.size) return null
    let mostKey = ''
    let mostCount = 0
    for (const [key, count] of counts) {
      if (count > mostCount) {
        mostCount = count
        mostKey = key
      }
    }
    if (!mostKey) return null
    const [xStr, yStr] = mostKey.split('_')
    const x = Number(xStr)
    const y = Number(yStr)
    const xorKey = x ^ 0xFF
    const check = y ^ 0xD9
    return xorKey === check ? xorKey : null
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

  private isAlphaNumAscii(byte: number): boolean {
    return (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39)
  }

  private isUtf16AsciiKey(buf: Buffer, start: number): boolean {
    if (start + 64 > buf.length) return false
    for (let j = 0; j < 32; j++) {
      const charByte = buf[start + j * 2]
      const nullByte = buf[start + j * 2 + 1]
      if (nullByte !== 0x00 || !this.isAlphaNumAscii(charByte)) {
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
      return decrypted[0] === 0xff && decrypted[1] === 0xd8 && decrypted[2] === 0xff
    } catch {
      return false
    }
  }

  private getMemoryRegions(hProcess: any): Array<[number, number]> {
    const regions: Array<[number, number]> = []
    const MEM_COMMIT = 0x1000
    const MEM_PRIVATE = 0x20000
    const MEM_MAPPED = 0x40000
    const MEM_IMAGE = 0x1000000
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
      if (state === MEM_COMMIT && (protect & PAGE_NOACCESS) === 0 && (protect & PAGE_GUARD) === 0) {
        if (type === MEM_PRIVATE || type === MEM_MAPPED || type === MEM_IMAGE) {
          regions.push([Number(info.BaseAddress), regionSize])
        }
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

  private async getAesKeyFromMemory(pid: number, ciphertext: Buffer): Promise<string | null> {
    if (!this.ensureKernel32()) return null
    const hProcess = this.OpenProcess(this.PROCESS_ALL_ACCESS, false, pid)
    if (!hProcess) return null

    try {
      const regions = this.getMemoryRegions(hProcess)
      const chunkSize = 4 * 1024 * 1024
      const overlap = 65
      for (const [baseAddress, regionSize] of regions) {
        if (regionSize > 100 * 1024 * 1024) continue
        let offset = 0
        let trailing: Buffer | null = null
        while (offset < regionSize) {
          const remaining = regionSize - offset
          const currentChunkSize = remaining > chunkSize ? chunkSize : remaining
          const chunk = this.readProcessMemory(hProcess, baseAddress + offset, currentChunkSize)
          if (!chunk || !chunk.length) {
            offset += currentChunkSize
            trailing = null
            continue
          }

          let dataToScan: Buffer
          if (trailing && trailing.length) {
            dataToScan = Buffer.concat([trailing, chunk])
          } else {
            dataToScan = chunk
          }

          for (let i = 0; i < dataToScan.length - 34; i++) {
            if (this.isAlphaNumAscii(dataToScan[i])) continue
            let valid = true
            for (let j = 1; j <= 32; j++) {
              if (!this.isAlphaNumAscii(dataToScan[i + j])) {
                valid = false
                break
              }
            }
            if (valid && this.isAlphaNumAscii(dataToScan[i + 33])) {
              valid = false
            }
            if (valid) {
              const keyBytes = dataToScan.subarray(i + 1, i + 33)
              if (this.verifyKey(ciphertext, keyBytes)) {
                return keyBytes.toString('ascii')
              }
            }
          }

          for (let i = 0; i < dataToScan.length - 65; i++) {
            if (!this.isUtf16AsciiKey(dataToScan, i)) continue
            const keyBytes = Buffer.alloc(32)
            for (let j = 0; j < 32; j++) {
              keyBytes[j] = dataToScan[i + j * 2]
            }
            if (this.verifyKey(ciphertext, keyBytes)) {
              return keyBytes.toString('ascii')
            }
          }

          const start = dataToScan.length - overlap
          trailing = dataToScan.subarray(start < 0 ? 0 : start)
          offset += currentChunkSize
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
    const aesKey = await this.getAesKeyFromMemory(pid, ciphertext)
    if (!aesKey) {
      return {
        success: false,
        error: '未能从内存中获取 AES 密钥，请打开朋友圈图片后重试'
      }
    }

    return { success: true, xorKey, aesKey: aesKey.slice(0, 16) }
  }
}
