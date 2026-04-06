import { join, dirname, basename } from 'path'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import * as fzstd from 'fzstd'

//数据服务初始化错误信息，用于帮助用户诊断问题
let lastDllInitError: string | null = null

export function getLastDllInitError(): string | null {
  return lastDllInitError
}

export class WcdbCore {
  private resourcesPath: string | null = null
  private userDataPath: string | null = null
  private logEnabled = false
  private lib: any = null
  private koffi: any = null
  private initialized = false
  private handle: number | null = null
  private currentPath: string | null = null
  private currentKey: string | null = null
  private currentWxid: string | null = null
  private currentDbStoragePath: string | null = null

  // 函数引用
  private wcdbInitProtection: any = null
  private wcdbInit: any = null
  private wcdbShutdown: any = null
  private wcdbOpenAccount: any = null
  private wcdbCloseAccount: any = null
  private wcdbSetMyWxid: any = null
  private wcdbFreeString: any = null
  private wcdbUpdateMessage: any = null
  private wcdbDeleteMessage: any = null
  private wcdbGetSessions: any = null
  private wcdbGetMessages: any = null
  private wcdbGetMessageCount: any = null
  private wcdbGetDisplayNames: any = null
  private wcdbGetAvatarUrls: any = null
  private wcdbGetGroupMemberCount: any = null
  private wcdbGetGroupMemberCounts: any = null
  private wcdbGetGroupMembers: any = null
  private wcdbGetGroupNicknames: any = null
  private wcdbGetMessageTables: any = null
  private wcdbGetMessageMeta: any = null
  private wcdbGetContact: any = null
  private wcdbGetContactStatus: any = null
  private wcdbGetContactTypeCounts: any = null
  private wcdbGetContactsCompact: any = null
  private wcdbGetContactAliasMap: any = null
  private wcdbGetContactFriendFlags: any = null
  private wcdbGetChatRoomExtBuffer: any = null
  private wcdbGetMessageTableStats: any = null
  private wcdbGetAggregateStats: any = null
  private wcdbGetAvailableYears: any = null
  private wcdbGetAnnualReportStats: any = null
  private wcdbGetAnnualReportExtras: any = null
  private wcdbGetDualReportStats: any = null
  private wcdbGetGroupStats: any = null
  private wcdbGetMessageDates: any = null
  private wcdbOpenMessageCursor: any = null
  private wcdbOpenMessageCursorLite: any = null
  private wcdbFetchMessageBatch: any = null
  private wcdbCloseMessageCursor: any = null
  private wcdbGetLogs: any = null
  private wcdbExecQuery: any = null
  private wcdbListMessageDbs: any = null
  private wcdbListMediaDbs: any = null
  private wcdbGetMessageById: any = null
  private wcdbGetEmoticonCdnUrl: any = null
  private wcdbGetEmoticonCaption: any = null
  private wcdbGetEmoticonCaptionStrict: any = null
  private wcdbGetDbStatus: any = null
  private wcdbGetVoiceData: any = null
  private wcdbGetVoiceDataBatch: any = null
  private wcdbGetMediaSchemaSummary: any = null
  private wcdbGetSessionMessageCounts: any = null
  private wcdbGetSessionMessageTypeStats: any = null
  private wcdbGetSessionMessageTypeStatsBatch: any = null
  private wcdbGetSessionMessageDateCounts: any = null
  private wcdbGetSessionMessageDateCountsBatch: any = null
  private wcdbGetMessagesByType: any = null
  private wcdbScanMediaStream: any = null
  private wcdbGetHeadImageBuffers: any = null
  private wcdbSearchMessages: any = null
  private wcdbGetSnsTimeline: any = null
  private wcdbGetSnsAnnualStats: any = null
  private wcdbGetSnsUsernames: any = null
  private wcdbGetSnsExportStats: any = null
  private wcdbGetMessageTableColumns: any = null
  private wcdbGetMessageTableTimeRange: any = null
  private wcdbResolveImageHardlink: any = null
  private wcdbResolveImageHardlinkBatch: any = null
  private wcdbResolveVideoHardlinkMd5: any = null
  private wcdbResolveVideoHardlinkMd5Batch: any = null
  private wcdbInstallMessageAntiRevokeTrigger: any = null
  private wcdbUninstallMessageAntiRevokeTrigger: any = null
  private wcdbCheckMessageAntiRevokeTrigger: any = null
  private wcdbInstallSnsBlockDeleteTrigger: any = null
  private wcdbUninstallSnsBlockDeleteTrigger: any = null
  private wcdbCheckSnsBlockDeleteTrigger: any = null
  private wcdbDeleteSnsPost: any = null
  private wcdbVerifyUser: any = null
  private wcdbStartMonitorPipe: any = null
  private wcdbStopMonitorPipe: any = null
  private wcdbGetMonitorPipeName: any = null
  private wcdbCloudInit: any = null
  private wcdbCloudReport: any = null
  private wcdbCloudStop: any = null

  private monitorPipeClient: any = null
  private monitorCallback: ((type: string, json: string) => void) | null = null
  private monitorReconnectTimer: any = null
  private monitorPipePath: string = ''


  private avatarUrlCache: Map<string, { url?: string; updatedAt: number }> = new Map()
  private readonly avatarCacheTtlMs = 10 * 60 * 1000
  private imageHardlinkCache: Map<string, { result: { success: boolean; data?: any; error?: string }; updatedAt: number }> = new Map()
  private videoHardlinkCache: Map<string, { result: { success: boolean; data?: any; error?: string }; updatedAt: number }> = new Map()
  private readonly hardlinkCacheTtlMs = 10 * 60 * 1000
  private readonly hardlinkCacheMaxEntries = 20000
  private logTimer: NodeJS.Timeout | null = null
  private lastLogTail: string | null = null
  private lastResolvedLogPath: string | null = null

  setPaths(resourcesPath: string, userDataPath: string): void {
    this.resourcesPath = resourcesPath
    this.userDataPath = userDataPath
    this.writeLog(`[bootstrap] setPaths resourcesPath=${resourcesPath} userDataPath=${userDataPath}`, true)
  }

  getLastInitError(): string | null {
    return lastDllInitError
  }

  setLogEnabled(enabled: boolean): void {
    this.logEnabled = enabled
    this.writeLog(`[bootstrap] setLogEnabled=${enabled ? '1' : '0'} env.WCDB_LOG_ENABLED=${process.env.WCDB_LOG_ENABLED || ''}`, true)
    if (this.isLogEnabled() && this.initialized) {
      this.startLogPolling()
    } else {
      this.stopLogPolling()
    }
  }

  // 使用命名管道/socket IPC (Windows: Named Pipe, macOS: Unix Socket)
  startMonitor(callback: (type: string, json: string) => void): boolean {
    if (!this.wcdbStartMonitorPipe) {
      return false
    }

    this.monitorCallback = callback

    try {
      const result = this.wcdbStartMonitorPipe()
      if (result !== 0) {
        return false
      }

      // 从数据服务获取动态管道名（含 PID）
      let pipePath = '\\\\.\\pipe\\weflow_monitor'
      if (this.wcdbGetMonitorPipeName) {
        try {
          const namePtr = [null as any]
          if (this.wcdbGetMonitorPipeName(namePtr) === 0 && namePtr[0]) {
            pipePath = this.koffi.decode(namePtr[0], 'char', -1)
            this.wcdbFreeString(namePtr[0])
          }
        } catch { }
      }
      this.connectMonitorPipe(pipePath)
      return true
    } catch (e) {
      console.error('[wcdbCore] startMonitor exception:', e)
      return false
    }
  }

  // 连接命名管道，支持断开后自动重连
  private connectMonitorPipe(pipePath: string) {
    this.monitorPipePath = pipePath
    const net = require('net')

    setTimeout(() => {
      if (!this.monitorCallback) return

      this.monitorPipeClient = net.createConnection(this.monitorPipePath, () => { })

      let buffer = ''
      this.monitorPipeClient.on('data', (data: Buffer) => {
        const rawChunk = data.toString('utf8')
        // macOS 侧可能使用 '\0' 或无换行分隔，统一归一化并兜底拆包
        const normalizedChunk = rawChunk
          .replace(/\u0000/g, '\n')
          .replace(/}\s*{/g, '}\n{')

        buffer += normalizedChunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line)
              this.monitorCallback?.(parsed.action || 'update', line)
            } catch {
              this.monitorCallback?.('update', line)
            }
          }
        }

        // 兜底：如果没有分隔符但已形成完整 JSON，则直接上报
        const tail = buffer.trim()
        if (tail.startsWith('{') && tail.endsWith('}')) {
          try {
            const parsed = JSON.parse(tail)
            this.monitorCallback?.(parsed.action || 'update', tail)
            buffer = ''
          } catch {
            // 不可解析则继续等待下一块数据
          }
        }
      })

      this.monitorPipeClient.on('error', () => {
        // 保持静默，与现有错误处理策略一致
      })

      this.monitorPipeClient.on('close', () => {
        this.monitorPipeClient = null
        this.scheduleReconnect()
      })
    }, 100)
  }

  // 定时重连
  private scheduleReconnect() {
    if (this.monitorReconnectTimer || !this.monitorCallback) return
    this.monitorReconnectTimer = setTimeout(() => {
      this.monitorReconnectTimer = null
      if (this.monitorCallback && !this.monitorPipeClient) {
        this.connectMonitorPipe(this.monitorPipePath)
      }
    }, 3000)
  }



  stopMonitor(): void {
    this.monitorCallback = null
    if (this.monitorReconnectTimer) {
      clearTimeout(this.monitorReconnectTimer)
      this.monitorReconnectTimer = null
    }
    if (this.monitorPipeClient) {
      this.monitorPipeClient.destroy()
      this.monitorPipeClient = null
    }
    if (this.wcdbStopMonitorPipe) {
      this.wcdbStopMonitorPipe()
    }
  }

  // 保留旧方法签名以兼容
  setMonitor(callback: (type: string, json: string) => void): boolean {
    return this.startMonitor(callback)
  }



  /**
   * 获取库文件路径（跨平台）
   */
  private getDllPath(): string {
    const isMac = process.platform === 'darwin'
    const isLinux = process.platform === 'linux'
    const isArm64 = process.arch === 'arm64'
    const libName = isMac ? 'libwcdb_api.dylib' : isLinux ? 'libwcdb_api.so' : 'wcdb_api.dll'
    const subDir = isMac ? 'macos' : isLinux ? 'linux' : (isArm64 ? 'arm64' : '')

    const envDllPath = process.env.WCDB_DLL_PATH
    if (envDllPath && envDllPath.length > 0) {
      return envDllPath
    }

    // 基础路径探测
    const isPackaged = typeof process['resourcesPath'] !== 'undefined'
    const resourcesPath = isPackaged ? process.resourcesPath : join(process.cwd(), 'resources')

    const candidates = [
      // 环境变量指定 resource 目录
      process.env.WCDB_RESOURCES_PATH ? join(process.env.WCDB_RESOURCES_PATH, subDir, libName) : null,
      // 显式 setPaths 设置的路径
      this.resourcesPath ? join(this.resourcesPath, subDir, libName) : null,
      // resources/macos/libwcdb_api.dylib 或 resources/wcdb_api.dll
      join(resourcesPath, 'resources', subDir, libName),
      // resources/libwcdb_api.dylib 或 resources/wcdb_api.dll (扁平结构)
      join(resourcesPath, subDir, libName),
      // CWD fallback
      join(process.cwd(), 'resources', subDir, libName)
    ].filter(Boolean) as string[]

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    return candidates[0] || libName
  }

  private formatInitProtectionError(code: number): string {
    const messages: Record<number, string> = {
      '-3001': '未找到数据库目录 (db_storage)，请确认已选择正确的微信数据目录（应包含以 wxid_ 开头的子文件夹）',
      '-3002': '未找到 session.db 文件，请确认微信已登录并且数据目录完整',
      '-3003': '数据库句柄无效，请重试',
      '-3004': '恢复数据库连接失败，请重试',
      '-2301': '动态库加载失败，请检查安装是否完整',
      '-2302': 'WCDB 初始化异常，请重试',
      '-2303': 'WCDB 未能成功初始化',
    }
    const msg = messages[String(code) as unknown as keyof typeof messages]
    return msg ? `${msg} (错误码: ${code})` : `操作失败，错误码: ${code}`
  }

  private isLogEnabled(): boolean {
    // 移除 Worker 线程的日志禁用逻辑，允许在 Worker 中记录日志
    if (process.env.WCDB_LOG_ENABLED === '1') return true
    return this.logEnabled
  }

  private writeLog(message: string, force = false): void {
    if (!force && !this.isLogEnabled()) return
    const line = `[${new Date().toISOString()}] ${message}`

    const candidates: string[] = []
    if (this.userDataPath) candidates.push(join(this.userDataPath, 'logs', 'wcdb.log'))
    if (process.env.WCDB_LOG_DIR) candidates.push(join(process.env.WCDB_LOG_DIR, 'logs', 'wcdb.log'))
    candidates.push(join(process.cwd(), 'logs', 'wcdb.log'))
    candidates.push(join(tmpdir(), 'weflow-wcdb.log'))

    const uniq = Array.from(new Set(candidates))
    for (const filePath of uniq) {
      try {
        const dir = dirname(filePath)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        appendFileSync(filePath, line + '\n', { encoding: 'utf8' })
        this.lastResolvedLogPath = filePath
        return
      } catch (e) {
        console.error(`[wcdbCore] writeLog failed path=${filePath}:`, e)
      }
    }

    console.error('[wcdbCore] writeLog failed for all candidates:', uniq.join(' | '))
  }

  private formatSqlForLog(sql: string, maxLen = 240): string {
    const compact = String(sql || '').replace(/\s+/g, ' ').trim()
    if (compact.length <= maxLen) return compact
    return compact.slice(0, maxLen) + '...'
  }

  private async dumpDbStatus(tag: string): Promise<void> {
    try {
      if (!this.ensureReady()) {
        this.writeLog(`[diag:${tag}] db_status skipped: not connected`, true)
        return
      }
      if (!this.wcdbGetDbStatus) {
        this.writeLog(`[diag:${tag}] db_status skipped: api not supported`, true)
        return
      }
      const outPtr = [null as any]
      const rc = this.wcdbGetDbStatus(this.handle, outPtr)
      if (rc !== 0 || !outPtr[0]) {
        this.writeLog(`[diag:${tag}] db_status failed rc=${rc} outPtr=${outPtr[0] ? 'set' : 'null'}`, true)
        return
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) {
        this.writeLog(`[diag:${tag}] db_status decode failed`, true)
        return
      }
      this.writeLog(`[diag:${tag}] db_status=${jsonStr}`, true)
    } catch (e) {
      this.writeLog(`[diag:${tag}] db_status exception: ${String(e)}`, true)
    }
  }

  private async runPostOpenDiagnostics(dbPath: string, dbStoragePath: string | null, sessionDbPath: string | null, wxid: string): Promise<void> {
    try {
      this.writeLog(`[diag:open] input dbPath=${dbPath} wxid=${wxid}`, true)
      this.writeLog(`[diag:open] resolved dbStorage=${dbStoragePath || 'null'}`, true)
      this.writeLog(`[diag:open] resolved sessionDb=${sessionDbPath || 'null'}`, true)
      if (!dbStoragePath) return
      try {
        const entries = readdirSync(dbStoragePath)
        const sample = entries.slice(0, 20).join(',')
        this.writeLog(`[diag:open] dbStorage entries(${entries.length}) sample=${sample}`, true)
      } catch (e) {
        this.writeLog(`[diag:open] list dbStorage failed: ${String(e)}`, true)
      }

      const contactProbe = await this.execQuery(
        'contact',
        null,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 50"
      )
      if (contactProbe.success) {
        const names = (contactProbe.rows || []).map((r: any) => String(r?.name || '')).filter(Boolean)
        this.writeLog(`[diag:open] contact sqlite_master rows=${names.length} names=${names.join(',')}`, true)
      } else {
        this.writeLog(`[diag:open] contact sqlite_master failed: ${contactProbe.error || 'unknown'}`, true)
      }

      const contactCount = await this.execQuery('contact', null, 'SELECT COUNT(1) AS cnt FROM contact')
      if (contactCount.success && Array.isArray(contactCount.rows) && contactCount.rows.length > 0) {
        this.writeLog(`[diag:open] contact count=${String((contactCount.rows[0] as any)?.cnt ?? '')}`, true)
      } else {
        this.writeLog(`[diag:open] contact count failed: ${contactCount.error || 'unknown'}`, true)
      }
    } catch (e) {
      this.writeLog(`[diag:open] post-open diagnostics exception: ${String(e)}`, true)
    }
  }

  /**
   * 递归查找 session.db 文件
   */
  private findSessionDb(dir: string, depth = 0): string | null {
    if (depth > 5) return null

    try {
      const entries = readdirSync(dir)

      for (const entry of entries) {
        if (entry.toLowerCase() === 'session.db') {
          const fullPath = join(dir, entry)
          if (statSync(fullPath).isFile()) {
            return fullPath
          }
        }
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isDirectory()) {
            const found = this.findSessionDb(fullPath, depth + 1)
            if (found) return found
          }
        } catch { }
      }
    } catch (e) {
      console.error('查找 session.db 失败:', e)
    }

    return null
  }

  private resolveDbStoragePath(basePath: string, wxid: string): string | null {
    if (!basePath) return null
    const normalized = basePath.replace(/[\\\\/]+$/, '')
    if (normalized.toLowerCase().endsWith('db_storage') && existsSync(normalized)) {
      return normalized
    }
    const direct = join(normalized, 'db_storage')
    if (existsSync(direct)) {
      return direct
    }
    if (wxid) {
      const viaWxid = join(normalized, wxid, 'db_storage')
      if (existsSync(viaWxid)) {
        return viaWxid
      }
      // 兼容目录名包含额外后缀（如 wxid_xxx_1234）
      try {
        const entries = readdirSync(normalized)
        const lowerWxid = wxid.toLowerCase()
        const candidates = entries.filter((entry) => {
          const entryPath = join(normalized, entry)
          try {
            if (!statSync(entryPath).isDirectory()) return false
          } catch {
            return false
          }
          const lowerEntry = entry.toLowerCase()
          return lowerEntry === lowerWxid || lowerEntry.startsWith(`${lowerWxid}_`)
        })
        for (const entry of candidates) {
          const candidate = join(normalized, entry, 'db_storage')
          if (existsSync(candidate)) {
            return candidate
          }
        }
      } catch { }
    }
    // 兜底：向上查找 db_storage（最多 2 级），处理用户选择了子目录的情况
    try {
      let parent = normalized
      for (let i = 0; i < 2; i++) {
        const up = join(parent, '..')
        if (up === parent) break
        parent = up
        const candidateUp = join(parent, 'db_storage')
        if (existsSync(candidateUp)) return candidateUp
        if (wxid) {
          const viaWxidUp = join(parent, wxid, 'db_storage')
          if (existsSync(viaWxidUp)) return viaWxidUp
        }
      }
    } catch { }
    // 兜底：递归搜索 basePath 下的 db_storage 目录（最多 3 层深）
    try {
      const found = this.findDbStorageRecursive(normalized, 3)
      if (found) return found
    } catch { }
    return null
  }

  private findDbStorageRecursive(dir: string, maxDepth: number): string | null {
    if (maxDepth <= 0) return null
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.toLowerCase() === 'db_storage') {
          const candidate = join(dir, entry)
          try { if (statSync(candidate).isDirectory()) return candidate } catch { }
        }
      }
      for (const entry of entries) {
        const entryPath = join(dir, entry)
        try {
          if (statSync(entryPath).isDirectory()) {
            const found = this.findDbStorageRecursive(entryPath, maxDepth - 1)
            if (found) return found
          }
        } catch { }
      }
    } catch { }
    return null
  }

  private isRealDbFileName(name: string): boolean {
    const lower = String(name || '').toLowerCase()
    if (!lower.endsWith('.db')) return false
    if (lower.endsWith('.db-shm')) return false
    if (lower.endsWith('.db-wal')) return false
    if (lower.endsWith('.db-journal')) return false
    return true
  }

  private resolveContactDbPath(): string | null {
    const dbStorage = this.currentDbStoragePath || this.resolveDbStoragePath(this.currentPath || '', this.currentWxid || '')
    if (!dbStorage) return null
    const contactDir = join(dbStorage, 'Contact')
    if (!existsSync(contactDir)) return null

    const preferred = [
      join(contactDir, 'contact.db'),
      join(contactDir, 'Contact.db')
    ]
    for (const p of preferred) {
      if (existsSync(p)) return p
    }

    try {
      const entries = readdirSync(contactDir)
      const cands = entries
        .filter((name) => this.isRealDbFileName(name))
        .map((name) => join(contactDir, name))
      if (cands.length > 0) return cands[0]
    } catch { }
    return null
  }

  private pickFirstStringField(row: Record<string, any>, candidates: string[]): string {
    for (const key of candidates) {
      const v = row[key]
      if (typeof v === 'string' && v.trim()) return v
      if (v !== null && v !== undefined) {
        const s = String(v).trim()
        if (s) return s
      }
    }
    return ''
  }

  private escapeSqlString(value: string): string {
    return String(value || '').replace(/'/g, "''")
  }

  private buildContactSelectSql(usernames: string[] = []): string {
    const uniq = Array.from(new Set((usernames || []).map((item) => String(item || '').trim()).filter(Boolean)))
    if (uniq.length === 0) return 'SELECT * FROM contact'
    const inList = uniq.map((username) => `'${this.escapeSqlString(username)}'`).join(',')
    return `SELECT * FROM contact WHERE username IN (${inList})`
  }

  private deriveContactTypeCounts(rows: Array<Record<string, any>>): { private: number; group: number; official: number; former_friend: number } {
    const counts = {
      private: 0,
      group: 0,
      official: 0,
      former_friend: 0
    }
    const excludeNames = new Set(['medianote', 'floatbottle', 'qmessage', 'qqmail', 'fmessage'])

    for (const row of rows || []) {
      const username = this.pickFirstStringField(row, ['username', 'user_name', 'userName'])
      if (!username) continue

      const localTypeRaw = row.local_type ?? row.localType ?? row.WCDB_CT_local_type ?? 0
      const localType = Number.isFinite(Number(localTypeRaw)) ? Math.floor(Number(localTypeRaw)) : 0
      const quanPin = this.pickFirstStringField(row, ['quan_pin', 'quanPin', 'WCDB_CT_quan_pin'])

      if (username.endsWith('@chatroom')) {
        counts.group += 1
      } else if (username.startsWith('gh_')) {
        counts.official += 1
      } else if (localType === 1 && !excludeNames.has(username)) {
        counts.private += 1
      } else if (localType === 0 && quanPin) {
        counts.former_friend += 1
      }
    }

    return counts
  }

  /**
   * 初始化 WCDB
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true

    try {
      this.koffi = require('koffi')
      const dllPath = this.getDllPath()
      this.writeLog(`[bootstrap] initialize platform=${process.platform} dllPath=${dllPath} resourcesPath=${this.resourcesPath || ''} userDataPath=${this.userDataPath || ''}`, true)

      if (!existsSync(dllPath)) {
        console.error('WCDB数据服务不存在:', dllPath)
        this.writeLog(`[bootstrap] initialize failed:数据服务not found path=${dllPath}`, true)
        return false
      }

      const dllDir = dirname(dllPath)
      const isMac = process.platform === 'darwin'
      const isLinux = process.platform === 'linux'

      // 预加载依赖库
      if (isMac) {
        const wcdbCorePath = join(dllDir, 'libWCDB.dylib')
        if (existsSync(wcdbCorePath)) {
          try {
            this.koffi.load(wcdbCorePath)
            this.writeLog('预加载 libWCDB.dylib 成功')
          } catch (e) {
            console.warn('预加载 libWCDB.dylib 失败(可能不是致命的):', e)
            this.writeLog(`预加载 libWCDB.dylib 失败: ${String(e)}`)
          }
        }
      } else if (isLinux) {
        // 如果有libWCDB.so的话， 没有就算了
      } else {
        const wcdbCorePath = join(dllDir, 'WCDB.dll')
        if (existsSync(wcdbCorePath)) {
          try {
            this.koffi.load(wcdbCorePath)
            this.writeLog('预加载 WCDB.dll 成功')
          } catch (e) {
            console.warn('预加载 WCDB.dll 失败(可能不是致命的):', e)
            this.writeLog(`预加载 WCDB.dll 失败: ${String(e)}`)
          }
        }
        const sdl2Path = join(dllDir, 'SDL2.dll')
        if (existsSync(sdl2Path)) {
          try {
            this.koffi.load(sdl2Path)
            this.writeLog('预加载 SDL2.dll 成功')
          } catch (e) {
            console.warn('预加载 SDL2.dll 失败(可能不是致命的):', e)
            this.writeLog(`预加载 SDL2.dll 失败: ${String(e)}`)
          }
        }
      }

      this.writeLog(`[bootstrap] koffi.load begin path=${dllPath}`, true)
      this.lib = this.koffi.load(dllPath)
      this.writeLog('[bootstrap] koffi.load ok', true)

      // InitProtection (Added for security)
      try {
        this.wcdbInitProtection = this.lib.func('int32 InitProtection(const char* resourcePath)')

        // 尝试多个可能的资源路径
        const resourcePaths = [
          dllDir,  //数据服务所在目录
          dirname(dllDir),  // 上级目录
          process.resourcesPath,  // 打包后 Contents/Resources
          process.resourcesPath ? join(process.resourcesPath as string, 'resources') : null,  // Contents/Resources/resources
          this.resourcesPath,  // 配置的资源路径
          join(process.cwd(), 'resources')  // 开发环境
        ].filter(Boolean)

        let protectionOk = false
        let protectionCode = -1
        let bestFailCode: number | null = null
        const scoreFailCode = (code: number): number => {
          if (code >= -2212 && code <= -2201) return 0 // manifest/signature/hash failures
          if (code === -102 || code === -101 || code === -1006) return 1
          return 2
        }
        for (const resPath of resourcePaths) {
          try {
            this.writeLog(`[bootstrap] InitProtection call path=${resPath}`, true)
            protectionCode = Number(this.wcdbInitProtection(resPath))
            if (protectionCode === 0) {
              protectionOk = true
              break
            }
            if (bestFailCode === null || scoreFailCode(protectionCode) < scoreFailCode(bestFailCode)) {
              bestFailCode = protectionCode
            }
            this.writeLog(`[bootstrap] InitProtection rc=${protectionCode} path=${resPath}`, true)
          } catch (e) {
            this.writeLog(`[bootstrap] InitProtection exception path=${resPath}: ${String(e)}`, true)
          }
        }

        if (!protectionOk) {
          const finalCode = bestFailCode ?? protectionCode
          lastDllInitError = this.formatInitProtectionError(finalCode)
          this.writeLog(`[bootstrap] InitProtection failed finalCode=${finalCode}`, true)
          return false
        }
      } catch (e) {
        lastDllInitError = this.formatInitProtectionError(-2301)
        this.writeLog(`[bootstrap] InitProtection symbol load failed: ${String(e)}`, true)
        return false
      }

      // 定义类型
      // wcdb_status wcdb_init()
      this.wcdbInit = this.lib.func('int32 wcdb_init()')

      // wcdb_status wcdb_shutdown()
      this.wcdbShutdown = this.lib.func('int32 wcdb_shutdown()')

      // wcdb_status wcdb_open_account(const char* session_db_path, const char* hex_key, wcdb_handle* out_handle)
      // wcdb_handle 是 int64_t
      this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)')

      // wcdb_status wcdb_close_account(wcdb_handle handle)
      //  C 接口是 int64， koffi 返回 handle 是 number 类型
      this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)')

      // wcdb_status wcdb_set_my_wxid(wcdb_handle handle, const char* wxid)
      try {
        this.wcdbSetMyWxid = this.lib.func('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)')
      } catch {
        this.wcdbSetMyWxid = null
      }

      // wcdb_status wcdb_update_message(wcdb_handle handle, const char* session_id, int64_t local_id, int32_t create_time, const char* new_content, char** out_error)
      try {
        this.wcdbUpdateMessage = this.lib.func('int32 wcdb_update_message(int64 handle, const char* sessionId, int64 localId, int32 createTime, const char* newContent, _Out_ void** outError)')
      } catch {
        this.wcdbUpdateMessage = null
      }

      // wcdb_status wcdb_delete_message(wcdb_handle handle, const char* session_id, int64_t local_id, char** out_error)
      try {
        this.wcdbDeleteMessage = this.lib.func('int32 wcdb_delete_message(int64 handle, const char* sessionId, int64 localId, int32 createTime, const char* dbPathHint, _Out_ void** outError)')
      } catch {
        this.wcdbDeleteMessage = null
      }

      // void wcdb_free_string(char* ptr)
      this.wcdbFreeString = this.lib.func('void wcdb_free_string(void* ptr)')

      // wcdb_status wcdb_get_sessions(wcdb_handle handle, char** out_json)
      this.wcdbGetSessions = this.lib.func('int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)')

      // wcdb_status wcdb_get_messages(wcdb_handle handle, const char* username, int32_t limit, int32_t offset, char** out_json)
      this.wcdbGetMessages = this.lib.func('int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)')

      // wcdb_status wcdb_get_message_count(wcdb_handle handle, const char* username, int32_t* out_count)
      this.wcdbGetMessageCount = this.lib.func('int32 wcdb_get_message_count(int64 handle, const char* username, _Out_ int32* outCount)')

      // wcdb_status wcdb_get_display_names(wcdb_handle handle, const char* usernames_json, char** out_json)
      this.wcdbGetDisplayNames = this.lib.func('int32 wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)')

      // wcdb_status wcdb_get_avatar_urls(wcdb_handle handle, const char* usernames_json, char** out_json)
      this.wcdbGetAvatarUrls = this.lib.func('int32 wcdb_get_avatar_urls(int64 handle, const char* usernamesJson, _Out_ void** outJson)')

      // wcdb_status wcdb_get_group_member_count(wcdb_handle handle, const char* chatroom_id, int32_t* out_count)
      this.wcdbGetGroupMemberCount = this.lib.func('int32 wcdb_get_group_member_count(int64 handle, const char* chatroomId, _Out_ int32* outCount)')

      // wcdb_status wcdb_get_group_member_counts(wcdb_handle handle, const char* chatroom_ids_json, char** out_json)
      try {
        this.wcdbGetGroupMemberCounts = this.lib.func('int32 wcdb_get_group_member_counts(int64 handle, const char* chatroomIdsJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetGroupMemberCounts = null
      }

      // wcdb_status wcdb_get_group_members(wcdb_handle handle, const char* chatroom_id, char** out_json)
      this.wcdbGetGroupMembers = this.lib.func('int32 wcdb_get_group_members(int64 handle, const char* chatroomId, _Out_ void** outJson)')

      // wcdb_status wcdb_get_group_nicknames(wcdb_handle handle, const char* chatroom_id, char** out_json)
      try {
        this.wcdbGetGroupNicknames = this.lib.func('int32 wcdb_get_group_nicknames(int64 handle, const char* chatroomId, _Out_ void** outJson)')
      } catch {
        this.wcdbGetGroupNicknames = null
      }

      // wcdb_status wcdb_get_message_tables(wcdb_handle handle, const char* session_id, char** out_json)
      this.wcdbGetMessageTables = this.lib.func('int32 wcdb_get_message_tables(int64 handle, const char* sessionId, _Out_ void** outJson)')

      // wcdb_status wcdb_get_message_meta(wcdb_handle handle, const char* db_path, const char* table_name, int32_t limit, int32_t offset, char** out_json)
      this.wcdbGetMessageMeta = this.lib.func('int32 wcdb_get_message_meta(int64 handle, const char* dbPath, const char* tableName, int32 limit, int32 offset, _Out_ void** outJson)')

      // wcdb_status wcdb_get_contact(wcdb_handle handle, const char* username, char** out_json)
      this.wcdbGetContact = this.lib.func('int32 wcdb_get_contact(int64 handle, const char* username, _Out_ void** outJson)')

      // wcdb_status wcdb_get_contact_status(wcdb_handle handle, const char* usernames_json, char** out_json)
      try {
        this.wcdbGetContactStatus = this.lib.func('int32 wcdb_get_contact_status(int64 handle, const char* usernamesJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetContactStatus = null
      }

      try {
        this.wcdbGetContactTypeCounts = this.lib.func('int32 wcdb_get_contact_type_counts(int64 handle, _Out_ void** outJson)')
      } catch {
        this.wcdbGetContactTypeCounts = null
      }
      try {
        this.wcdbGetContactsCompact = this.lib.func('int32 wcdb_get_contacts_compact(int64 handle, const char* usernamesJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetContactsCompact = null
      }
      try {
        this.wcdbGetContactAliasMap = this.lib.func('int32 wcdb_get_contact_alias_map(int64 handle, const char* usernamesJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetContactAliasMap = null
      }
      try {
        this.wcdbGetContactFriendFlags = this.lib.func('int32 wcdb_get_contact_friend_flags(int64 handle, const char* usernamesJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetContactFriendFlags = null
      }
      try {
        this.wcdbGetChatRoomExtBuffer = this.lib.func('int32 wcdb_get_chat_room_ext_buffer(int64 handle, const char* chatroomId, _Out_ void** outJson)')
      } catch {
        this.wcdbGetChatRoomExtBuffer = null
      }

      // wcdb_status wcdb_get_message_table_stats(wcdb_handle handle, const char* session_id, char** out_json)
      this.wcdbGetMessageTableStats = this.lib.func('int32 wcdb_get_message_table_stats(int64 handle, const char* sessionId, _Out_ void** outJson)')

      // wcdb_status wcdb_get_aggregate_stats(wcdb_handle handle, const char* session_ids_json, int32_t begin_timestamp, int32_t end_timestamp, char** out_json)
      this.wcdbGetAggregateStats = this.lib.func('int32 wcdb_get_aggregate_stats(int64 handle, const char* sessionIdsJson, int32 begin, int32 end, _Out_ void** outJson)')

      // wcdb_status wcdb_get_available_years(wcdb_handle handle, const char* session_ids_json, char** out_json)
      try {
        this.wcdbGetAvailableYears = this.lib.func('int32 wcdb_get_available_years(int64 handle, const char* sessionIdsJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetAvailableYears = null
      }

      // wcdb_status wcdb_get_annual_report_stats(wcdb_handle handle, const char* session_ids_json, int32_t begin_timestamp, int32_t end_timestamp, char** out_json)
      try {
        this.wcdbGetAnnualReportStats = this.lib.func('int32 wcdb_get_annual_report_stats(int64 handle, const char* sessionIdsJson, int32 begin, int32 end, _Out_ void** outJson)')
      } catch {
        this.wcdbGetAnnualReportStats = null
      }

      // wcdb_status wcdb_get_annual_report_extras(wcdb_handle handle, const char* session_ids_json, int32_t begin_timestamp, int32_t end_timestamp, int32_t peak_day_begin, int32_t peak_day_end, char** out_json)
      try {
        this.wcdbGetAnnualReportExtras = this.lib.func('int32 wcdb_get_annual_report_extras(int64 handle, const char* sessionIdsJson, int32 begin, int32 end, int32 peakBegin, int32 peakEnd, _Out_ void** outJson)')
      } catch {
        this.wcdbGetAnnualReportExtras = null
      }

      // wcdb_status wcdb_get_dual_report_stats(wcdb_handle handle, const char* session_id, int32_t begin_timestamp, int32_t end_timestamp, char** out_json)
      try {
        this.wcdbGetDualReportStats = this.lib.func('int32 wcdb_get_dual_report_stats(int64 handle, const char* sessionId, int32 begin, int32 end, _Out_ void** outJson)')
      } catch {
        this.wcdbGetDualReportStats = null
      }

      // wcdb_status wcdb_get_logs(char** out_json)
      try {
        this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')
      } catch {
        this.wcdbGetLogs = null
      }

      // wcdb_status wcdb_get_group_stats(wcdb_handle handle, const char* chatroom_id, int32_t begin_timestamp, int32_t end_timestamp, char** out_json)
      try {
        this.wcdbGetGroupStats = this.lib.func('int32 wcdb_get_group_stats(int64 handle, const char* chatroomId, int32 begin, int32 end, _Out_ void** outJson)')
      } catch {
        this.wcdbGetGroupStats = null
      }

      // wcdb_status wcdb_get_message_dates(wcdb_handle handle, const char* session_id, char** out_json)
      try {
        this.wcdbGetMessageDates = this.lib.func('int32 wcdb_get_message_dates(int64 handle, const char* sessionId, _Out_ void** outJson)')
      } catch {
        this.wcdbGetMessageDates = null
      }

      // wcdb_status wcdb_open_message_cursor(wcdb_handle handle, const char* session_id, int32_t batch_size, int32_t ascending, int32_t begin_timestamp, int32_t end_timestamp, wcdb_cursor* out_cursor)
      this.wcdbOpenMessageCursor = this.lib.func('int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)')

      // wcdb_status wcdb_open_message_cursor_lite(wcdb_handle handle, const char* session_id, int32_t batch_size, int32_t ascending, int32_t begin_timestamp, int32_t end_timestamp, wcdb_cursor* out_cursor)
      try {
        this.wcdbOpenMessageCursorLite = this.lib.func('int32 wcdb_open_message_cursor_lite(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)')
      } catch {
        this.wcdbOpenMessageCursorLite = null
      }

      // wcdb_status wcdb_fetch_message_batch(wcdb_handle handle, wcdb_cursor cursor, char** out_json, int32_t* out_has_more)
      this.wcdbFetchMessageBatch = this.lib.func('int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)')

      // wcdb_status wcdb_close_message_cursor(wcdb_handle handle, wcdb_cursor cursor)
      this.wcdbCloseMessageCursor = this.lib.func('int32 wcdb_close_message_cursor(int64 handle, int64 cursor)')

      // wcdb_status wcdb_get_logs(char** out_json)
      this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')

      // wcdb_status wcdb_exec_query(wcdb_handle handle, const char* db_kind, const char* db_path, const char* sql, char** out_json)
      this.wcdbExecQuery = this.lib.func('int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)')

      // wcdb_status wcdb_get_emoticon_cdn_url(wcdb_handle handle, const char* db_path, const char* md5, char** out_url)
      this.wcdbGetEmoticonCdnUrl = this.lib.func('int32 wcdb_get_emoticon_cdn_url(int64 handle, const char* dbPath, const char* md5, _Out_ void** outUrl)')

      // wcdb_status wcdb_get_emoticon_caption(wcdb_handle handle, const char* db_path, const char* md5, char** out_caption)
      try {
        this.wcdbGetEmoticonCaption = this.lib.func('int32 wcdb_get_emoticon_caption(int64 handle, const char* dbPath, const char* md5, _Out_ void** outCaption)')
      } catch (e) {
        this.wcdbGetEmoticonCaption = null
        this.writeLog(`[diag:emoji] symbol missing wcdb_get_emoticon_caption: ${String(e)}`, true)
      }

      // wcdb_status wcdb_get_emoticon_caption_strict(wcdb_handle handle, const char* md5, char** out_caption)
      try {
        this.wcdbGetEmoticonCaptionStrict = this.lib.func('int32 wcdb_get_emoticon_caption_strict(int64 handle, const char* md5, _Out_ void** outCaption)')
      } catch (e) {
        this.wcdbGetEmoticonCaptionStrict = null
        this.writeLog(`[diag:emoji] symbol missing wcdb_get_emoticon_caption_strict: ${String(e)}`, true)
      }

      // wcdb_status wcdb_list_message_dbs(wcdb_handle handle, char** out_json)
      this.wcdbListMessageDbs = this.lib.func('int32 wcdb_list_message_dbs(int64 handle, _Out_ void** outJson)')

      // wcdb_status wcdb_list_media_dbs(wcdb_handle handle, char** out_json)
      this.wcdbListMediaDbs = this.lib.func('int32 wcdb_list_media_dbs(int64 handle, _Out_ void** outJson)')

      // wcdb_status wcdb_get_message_by_id(wcdb_handle handle, const char* session_id, int32 local_id, char** out_json)
      this.wcdbGetMessageById = this.lib.func('int32 wcdb_get_message_by_id(int64 handle, const char* sessionId, int32 localId, _Out_ void** outJson)')

      // wcdb_status wcdb_get_db_status(wcdb_handle handle, char** out_json)
      try {
        this.wcdbGetDbStatus = this.lib.func('int32 wcdb_get_db_status(int64 handle, _Out_ void** outJson)')
      } catch {
        this.wcdbGetDbStatus = null
      }

      // wcdb_status wcdb_get_voice_data(wcdb_handle handle, const char* session_id, int32_t create_time, int32_t local_id, int64_t svr_id, const char* candidates_json, char** out_hex)
      try {
        this.wcdbGetVoiceData = this.lib.func('int32 wcdb_get_voice_data(int64 handle, const char* sessionId, int32 createTime, int32 localId, int64 svrId, const char* candidatesJson, _Out_ void** outHex)')
      } catch {
        this.wcdbGetVoiceData = null
      }
      try {
        this.wcdbGetVoiceDataBatch = this.lib.func('int32 wcdb_get_voice_data_batch(int64 handle, const char* requestsJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetVoiceDataBatch = null
      }
      try {
        this.wcdbGetMediaSchemaSummary = this.lib.func('int32 wcdb_get_media_schema_summary(int64 handle, const char* dbPath, _Out_ void** outJson)')
      } catch {
        this.wcdbGetMediaSchemaSummary = null
      }
      try {
        this.wcdbGetSessionMessageCounts = this.lib.func('int32 wcdb_get_session_message_counts(int64 handle, const char* sessionIdsJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSessionMessageCounts = null
      }
      try {
        this.wcdbGetSessionMessageTypeStats = this.lib.func('int32 wcdb_get_session_message_type_stats(int64 handle, const char* sessionId, int32 beginTimestamp, int32 endTimestamp, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSessionMessageTypeStats = null
      }
      try {
        this.wcdbGetSessionMessageTypeStatsBatch = this.lib.func('int32 wcdb_get_session_message_type_stats_batch(int64 handle, const char* sessionIdsJson, const char* optionsJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSessionMessageTypeStatsBatch = null
      }
      try {
        this.wcdbGetSessionMessageDateCounts = this.lib.func('int32 wcdb_get_session_message_date_counts(int64 handle, const char* sessionId, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSessionMessageDateCounts = null
      }
      try {
        this.wcdbGetSessionMessageDateCountsBatch = this.lib.func('int32 wcdb_get_session_message_date_counts_batch(int64 handle, const char* sessionIdsJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSessionMessageDateCountsBatch = null
      }
      try {
        this.wcdbGetMessagesByType = this.lib.func('int32 wcdb_get_messages_by_type(int64 handle, const char* sessionId, int64 localType, int32 ascending, int32 limit, int32 offset, _Out_ void** outJson)')
      } catch {
        this.wcdbGetMessagesByType = null
      }
      try {
        this.wcdbScanMediaStream = this.lib.func('int32 wcdb_scan_media_stream(int64 handle, const char* sessionIdsJson, int32 mediaType, int32 beginTimestamp, int32 endTimestamp, int32 limit, int32 offset, _Out_ void** outJson, _Out_ int32* outHasMore)')
      } catch {
        this.wcdbScanMediaStream = null
      }
      try {
        this.wcdbGetHeadImageBuffers = this.lib.func('int32 wcdb_get_head_image_buffers(int64 handle, const char* usernamesJson, _Out_ void** outJson)')
      } catch {
        this.wcdbGetHeadImageBuffers = null
      }

      // wcdb_status wcdb_search_messages(wcdb_handle handle, const char* session_id, const char* keyword, int32_t limit, int32_t offset, int32_t begin_timestamp, int32_t end_timestamp, char** out_json)
      try {
        this.wcdbSearchMessages = this.lib.func('int32 wcdb_search_messages(int64 handle, const char* sessionId, const char* keyword, int32 limit, int32 offset, int32 beginTimestamp, int32 endTimestamp, _Out_ void** outJson)')
      } catch {
        this.wcdbSearchMessages = null
      }

      // wcdb_status wcdb_get_sns_timeline(wcdb_handle handle, int32_t limit, int32_t offset, const char* username, const char* keyword, int32_t start_time, int32_t end_time, char** out_json)
      try {
        this.wcdbGetSnsTimeline = this.lib.func('int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSnsTimeline = null
      }

      // wcdb_status wcdb_get_sns_annual_stats(wcdb_handle handle, int32_t begin_timestamp, int32_t end_timestamp, char** out_json)
      try {
        this.wcdbGetSnsAnnualStats = this.lib.func('int32 wcdb_get_sns_annual_stats(int64 handle, int32 begin, int32 end, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSnsAnnualStats = null
      }
      try {
        this.wcdbGetSnsUsernames = this.lib.func('int32 wcdb_get_sns_usernames(int64 handle, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSnsUsernames = null
      }
      try {
        this.wcdbGetSnsExportStats = this.lib.func('int32 wcdb_get_sns_export_stats(int64 handle, const char* myWxid, _Out_ void** outJson)')
      } catch {
        this.wcdbGetSnsExportStats = null
      }
      try {
        this.wcdbGetMessageTableColumns = this.lib.func('int32 wcdb_get_message_table_columns(int64 handle, const char* dbPath, const char* tableName, _Out_ void** outJson)')
      } catch {
        this.wcdbGetMessageTableColumns = null
      }
      try {
        this.wcdbGetMessageTableTimeRange = this.lib.func('int32 wcdb_get_message_table_time_range(int64 handle, const char* dbPath, const char* tableName, _Out_ void** outJson)')
      } catch {
        this.wcdbGetMessageTableTimeRange = null
      }
      try {
        this.wcdbResolveImageHardlink = this.lib.func('int32 wcdb_resolve_image_hardlink(int64 handle, const char* md5, const char* accountDir, _Out_ void** outJson)')
      } catch {
        this.wcdbResolveImageHardlink = null
      }
      try {
        this.wcdbResolveImageHardlinkBatch = this.lib.func('int32 wcdb_resolve_image_hardlink_batch(int64 handle, const char* requestsJson, _Out_ void** outJson)')
      } catch {
        this.wcdbResolveImageHardlinkBatch = null
      }
      try {
        this.wcdbResolveVideoHardlinkMd5 = this.lib.func('int32 wcdb_resolve_video_hardlink_md5(int64 handle, const char* md5, const char* dbPath, _Out_ void** outJson)')
      } catch {
        this.wcdbResolveVideoHardlinkMd5 = null
      }
      try {
        this.wcdbResolveVideoHardlinkMd5Batch = this.lib.func('int32 wcdb_resolve_video_hardlink_md5_batch(int64 handle, const char* requestsJson, _Out_ void** outJson)')
      } catch {
        this.wcdbResolveVideoHardlinkMd5Batch = null
      }

      // wcdb_status wcdb_install_message_anti_revoke_trigger(wcdb_handle handle, const char* session_id, char** out_error)
      try {
        this.wcdbInstallMessageAntiRevokeTrigger = this.lib.func('int32 wcdb_install_message_anti_revoke_trigger(int64 handle, const char* sessionId, _Out_ void** outError)')
      } catch {
        this.wcdbInstallMessageAntiRevokeTrigger = null
      }

      // wcdb_status wcdb_uninstall_message_anti_revoke_trigger(wcdb_handle handle, const char* session_id, char** out_error)
      try {
        this.wcdbUninstallMessageAntiRevokeTrigger = this.lib.func('int32 wcdb_uninstall_message_anti_revoke_trigger(int64 handle, const char* sessionId, _Out_ void** outError)')
      } catch {
        this.wcdbUninstallMessageAntiRevokeTrigger = null
      }

      // wcdb_status wcdb_check_message_anti_revoke_trigger(wcdb_handle handle, const char* session_id, int32_t* out_installed)
      try {
        this.wcdbCheckMessageAntiRevokeTrigger = this.lib.func('int32 wcdb_check_message_anti_revoke_trigger(int64 handle, const char* sessionId, _Out_ int32* outInstalled)')
      } catch {
        this.wcdbCheckMessageAntiRevokeTrigger = null
      }

      // wcdb_status wcdb_install_sns_block_delete_trigger(wcdb_handle handle, char** out_error)
      try {
        this.wcdbInstallSnsBlockDeleteTrigger = this.lib.func('int32 wcdb_install_sns_block_delete_trigger(int64 handle, _Out_ void** outError)')
      } catch {
        this.wcdbInstallSnsBlockDeleteTrigger = null
      }

      // wcdb_status wcdb_uninstall_sns_block_delete_trigger(wcdb_handle handle, char** out_error)
      try {
        this.wcdbUninstallSnsBlockDeleteTrigger = this.lib.func('int32 wcdb_uninstall_sns_block_delete_trigger(int64 handle, _Out_ void** outError)')
      } catch {
        this.wcdbUninstallSnsBlockDeleteTrigger = null
      }

      // wcdb_status wcdb_check_sns_block_delete_trigger(wcdb_handle handle, int32_t* out_installed)
      try {
        this.wcdbCheckSnsBlockDeleteTrigger = this.lib.func('int32 wcdb_check_sns_block_delete_trigger(int64 handle, _Out_ int32* outInstalled)')
      } catch {
        this.wcdbCheckSnsBlockDeleteTrigger = null
      }

      // wcdb_status wcdb_delete_sns_post(wcdb_handle handle, const char* post_id, char** out_error)
      try {
        this.wcdbDeleteSnsPost = this.lib.func('int32 wcdb_delete_sns_post(int64 handle, const char* postId, _Out_ void** outError)')
      } catch {
        this.wcdbDeleteSnsPost = null
      }

      // Named pipe IPC for monitoring (replaces callback)
      try {
        this.wcdbStartMonitorPipe = this.lib.func('int32 wcdb_start_monitor_pipe()')
        this.wcdbStopMonitorPipe = this.lib.func('void wcdb_stop_monitor_pipe()')
        this.wcdbGetMonitorPipeName = this.lib.func('int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)')
        this.writeLog('Monitor pipe functions loaded')
      } catch (e) {
        console.warn('Failed to load monitor pipe functions:', e)
        this.wcdbStartMonitorPipe = null
        this.wcdbStopMonitorPipe = null
        this.wcdbGetMonitorPipeName = null
      }

      // void VerifyUser(int64_t hwnd_ptr, const char* message, char* out_result, int max_len)
      try {
        this.wcdbVerifyUser = this.lib.func('void VerifyUser(int64 hwnd, const char* message, _Out_ char* outResult, int maxLen)')
      } catch {
        this.wcdbVerifyUser = null
      }

      // wcdb_status wcdb_cloud_init(int32_t interval_seconds)
      try {
        this.wcdbCloudInit = this.lib.func('int32 wcdb_cloud_init(int32 intervalSeconds)')
      } catch {
        this.wcdbCloudInit = null
      }

      // wcdb_status wcdb_cloud_report(const char* stats_json)
      try {
        this.wcdbCloudReport = this.lib.func('int32 wcdb_cloud_report(const char* statsJson)')
      } catch {
        this.wcdbCloudReport = null
      }

      // void wcdb_cloud_stop()
      try {
        this.wcdbCloudStop = this.lib.func('void wcdb_cloud_stop()')
      } catch {
        this.wcdbCloudStop = null
      }


      // 初始化
      const initResult = this.wcdbInit()
      if (initResult !== 0) {
        console.error('WCDB 初始化失败:', initResult)
        lastDllInitError = this.formatInitProtectionError(initResult)
        return false
      }

      this.initialized = true
      lastDllInitError = null
      return true
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      console.error('WCDB 初始化异常:', errorMsg)
      this.writeLog(`WCDB 初始化异常: ${errorMsg}`, true)
      lastDllInitError = this.formatInitProtectionError(-2302)
      return false
    }
  }

  /**
   * 测试数据库连接
   */
  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    try {
      // 如果当前已经有相同参数的活动连接，直接返回成功
      if (this.handle !== null &&
        this.currentPath === dbPath &&
        this.currentKey === hexKey &&
        this.currentWxid === wxid) {
        return { success: true, sessionCount: 0 }
      }

      // 记录当前活动连接，用于在测试结束后恢复（避免影响聊天页等正在使用的连接）
      const hadActiveConnection = this.handle !== null
      const prevPath = this.currentPath
      const prevKey = this.currentKey
      const prevWxid = this.currentWxid

      if (!this.initialized) {
        const initOk = await this.initialize()
        if (!initOk) {
          const detailedError = lastDllInitError || this.formatInitProtectionError(-2303)
          return { success: false, error: detailedError }
        }
      }

      // 构建 db_storage 目录路径
      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      this.writeLog(`testConnection dbPath=${dbPath} wxid=${wxid} dbStorage=${dbStoragePath || 'null'}`)

      if (!dbStoragePath || !existsSync(dbStoragePath)) {
        return { success: false, error: this.formatInitProtectionError(-3001) }
      }

      // 递归查找 session.db
      const sessionDbPath = this.findSessionDb(dbStoragePath)
      this.writeLog(`testConnection sessionDb=${sessionDbPath || 'null'}`)

      if (!sessionDbPath) {
        return { success: false, error: this.formatInitProtectionError(-3002) }
      }

      // 分配输出参数内存
      const handleOut = [0]
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)

      if (result !== 0) {
        await this.printLogs()
        this.writeLog(`testConnection openAccount failed code=${result}`)
        return { success: false, error: this.formatInitProtectionError(result) }
      }

      const tempHandle = handleOut[0]
      if (tempHandle <= 0) {
        return { success: false, error: this.formatInitProtectionError(-3003) }
      }

      // 测试成功：使用 shutdown 清理资源（包括测试句柄）
      // 注意：shutdown 会断开当前活动连接，因此需要在测试后尝试恢复之前的连接
      try {
        this.wcdbShutdown()
        this.handle = null
        this.currentPath = null
        this.currentKey = null
        this.currentWxid = null
        this.initialized = false
      } catch (closeErr) {
        console.error('关闭测试数据库时出错:', closeErr)
      }

      // 恢复测试前的连接（如果之前有活动连接）
      if (hadActiveConnection && prevPath && prevKey && prevWxid) {
        try {
          await this.open(prevPath, prevKey, prevWxid)
        } catch {
          // 恢复失败则保持断开，由调用方处理
        }
      }

      return { success: true, sessionCount: 0 }
    } catch (e) {
      console.error('测试连接异常:', e)
      this.writeLog(`testConnection exception: ${String(e)}`)
      return { success: false, error: this.formatInitProtectionError(-3004) }
    }
  }

  /**
   * 打印数据服务内部日志（仅在出错时调用）
   */
  private async printLogs(force = false): Promise<void> {
    try {
      if (!this.wcdbGetLogs) return
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result === 0 && outPtr[0]) {
        try {
          const jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
          this.writeLog(`wcdb_logs: ${jsonStr}`, force)
          this.wcdbFreeString(outPtr[0])
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      console.error('获取日志失败:', e)
      this.writeLog(`wcdb_logs failed: ${String(e)}`, force)
    }
  }

  private startLogPolling(): void {
    if (this.logTimer || !this.isLogEnabled()) return
    this.logTimer = setInterval(() => {
      void this.pollLogs()
    }, 2000)
  }

  private stopLogPolling(): void {
    if (this.logTimer) {
      clearInterval(this.logTimer)
      this.logTimer = null
    }
    this.lastLogTail = null
  }

  private async pollLogs(): Promise<void> {
    try {
      if (!this.wcdbGetLogs || !this.isLogEnabled()) return
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result !== 0 || !outPtr[0]) return
      let jsonStr = ''
      try {
        jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
      } finally {
        try { this.wcdbFreeString(outPtr[0]) } catch { }
      }
      const logs = JSON.parse(jsonStr) as string[]
      if (!Array.isArray(logs) || logs.length === 0) return
      let startIdx = 0
      if (this.lastLogTail) {
        const idx = logs.lastIndexOf(this.lastLogTail)
        if (idx >= 0) startIdx = idx + 1
      }
      for (let i = startIdx; i < logs.length; i += 1) {
        this.writeLog(`wcdb: ${logs[i]}`)
      }
      this.lastLogTail = logs[logs.length - 1]
    } catch (e) {
      // ignore polling errors
    }
  }

  private decodeJsonPtr(outPtr: any): string | null {
    if (!outPtr) return null
    try {
      const jsonStr = this.koffi.decode(outPtr, 'char', -1)
      this.wcdbFreeString(outPtr)
      return jsonStr
    } catch (e) {
      try { this.wcdbFreeString(outPtr) } catch { }
      return null
    }
  }

  private parseMessageJson(jsonStr: string): any {
    const raw = String(jsonStr || '')
    if (!raw) return []
    // 热路径优化：仅在检测到 16+ 位整数字段时才进行字符串包裹，避免每批次多轮全量 replace。
    const needsInt64Normalize = /"server_id"\s*:\s*-?\d{16,}/.test(raw)
    if (!needsInt64Normalize) {
      return JSON.parse(raw)
    }
    const normalized = raw.replace(
      /("server_id"\s*:\s*)(-?\d{16,})/g,
      '$1"$2"'
    )
    return JSON.parse(normalized)
  }

  private ensureReady(): boolean {
    return this.initialized && this.handle !== null
  }

  private normalizeTimestamp(input: number): number {
    if (!input || input <= 0) return 0
    const asNumber = Number(input)
    if (!Number.isFinite(asNumber)) return 0
    // Treat >1e12 as milliseconds.
    const seconds = asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber)
    const maxInt32 = 2147483647
    return Math.min(Math.max(seconds, 0), maxInt32)
  }

  private normalizeRange(beginTimestamp: number, endTimestamp: number): { begin: number; end: number } {
    const normalizedBegin = this.normalizeTimestamp(beginTimestamp)
    let normalizedEnd = this.normalizeTimestamp(endTimestamp)
    if (normalizedEnd <= 0) {
      normalizedEnd = this.normalizeTimestamp(Date.now())
    }
    if (normalizedBegin > 0 && normalizedEnd < normalizedBegin) {
      normalizedEnd = normalizedBegin
    }
    return { begin: normalizedBegin, end: normalizedEnd }
  }

  private makeHardlinkCacheKey(primary: string, secondary?: string | null): string {
    const a = String(primary || '').trim().toLowerCase()
    const b = String(secondary || '').trim().toLowerCase()
    return `${a}\u001f${b}`
  }

  private readHardlinkCache(
    cache: Map<string, { result: { success: boolean; data?: any; error?: string }; updatedAt: number }>,
    key: string
  ): { success: boolean; data?: any; error?: string } | null {
    const entry = cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.updatedAt > this.hardlinkCacheTtlMs) {
      cache.delete(key)
      return null
    }
    return this.cloneHardlinkResult(entry.result)
  }

  private writeHardlinkCache(
    cache: Map<string, { result: { success: boolean; data?: any; error?: string }; updatedAt: number }>,
    key: string,
    result: { success: boolean; data?: any; error?: string }
  ): void {
    cache.set(key, {
      result: this.cloneHardlinkResult(result),
      updatedAt: Date.now()
    })
    if (cache.size <= this.hardlinkCacheMaxEntries) return

    const now = Date.now()
    for (const [cacheKey, entry] of cache) {
      if (now - entry.updatedAt > this.hardlinkCacheTtlMs) {
        cache.delete(cacheKey)
      }
    }

    while (cache.size > this.hardlinkCacheMaxEntries) {
      const oldestKey = cache.keys().next().value as string | undefined
      if (!oldestKey) break
      cache.delete(oldestKey)
    }
  }

  private cloneHardlinkResult(result: { success: boolean; data?: any; error?: string }): { success: boolean; data?: any; error?: string } {
    const data = result.data && typeof result.data === 'object'
      ? { ...result.data }
      : result.data
    return {
      success: result.success === true,
      data,
      error: result.error
    }
  }

  private clearHardlinkCaches(): void {
    this.imageHardlinkCache.clear()
    this.videoHardlinkCache.clear()
  }

  isReady(): boolean {
    return this.ensureReady()
  }

  /**
   * 打开数据库
   */
  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    try {
      lastDllInitError = null
      if (!this.initialized) {
        const initOk = await this.initialize()
        if (!initOk) return false
      }

      // 检查是否已经是当前连接的参数，如果是则直接返回成功，实现"始终保持链接"
      if (this.handle !== null &&
        this.currentPath === dbPath &&
        this.currentKey === hexKey &&
        this.currentWxid === wxid) {
        return true
      }

      // 如果参数不同，则先关闭原来的连接
      if (this.handle !== null) {
        this.close()
        // 重新初始化，因为 close 呼叫了 shutdown
        const initOk = await this.initialize()
        if (!initOk) return false
      }

      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      this.writeLog(`open dbPath=${dbPath} wxid=${wxid} dbStorage=${dbStoragePath || 'null'}`, true)

      if (!dbStoragePath || !existsSync(dbStoragePath)) {
        console.error('数据库目录不存在:', dbPath)
        this.writeLog(`open failed: dbStorage not found for ${dbPath}`)
        lastDllInitError = this.formatInitProtectionError(-3001)
        return false
      }

      const sessionDbPath = this.findSessionDb(dbStoragePath)
      this.writeLog(`open sessionDb=${sessionDbPath || 'null'}`, true)
      if (!sessionDbPath) {
        console.error('未找到 session.db 文件')
        this.writeLog('open failed: session.db not found')
        lastDllInitError = this.formatInitProtectionError(-3002)
        return false
      }

      const handleOut = [0]
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)

      if (result !== 0) {
        console.error('打开数据库失败:', result)
        await this.printLogs()
        this.writeLog(`open failed: openAccount code=${result}`)
        lastDllInitError = this.formatInitProtectionError(result)
        return false
      }

      const handle = handleOut[0]
      if (handle <= 0) {
        lastDllInitError = this.formatInitProtectionError(-3003)
        return false
      }

      this.handle = handle
      this.currentPath = dbPath
      this.currentKey = hexKey
      this.currentWxid = wxid
      this.currentDbStoragePath = dbStoragePath
      this.initialized = true
      lastDllInitError = null
      if (this.wcdbSetMyWxid && wxid) {
        try {
          this.wcdbSetMyWxid(this.handle, wxid)
        } catch (e) {
          // 静默失败
        }
      }
      if (this.isLogEnabled()) {
        this.startLogPolling()
      }
      this.writeLog(`open ok handle=${handle}`, true)
      await this.dumpDbStatus('open')
      await this.runPostOpenDiagnostics(dbPath, dbStoragePath, sessionDbPath, wxid)
      return true
    } catch (e) {
      console.error('打开数据库异常:', e)
      this.writeLog(`open exception: ${String(e)}`)
      lastDllInitError = this.formatInitProtectionError(-3004)
      return false
    }
  }

  /**
   * 关闭数据库
   * 注意：wcdb_close_account 可能导致崩溃，使用 shutdown 代替
   */
  close(): void {
    if (this.handle !== null || this.initialized) {
      try {
        // 不调用 closeAccount，直接 shutdown
        this.wcdbShutdown()
      } catch (e) {
        console.error('WCDB shutdown 出错:', e)
      }
      this.handle = null
      this.currentPath = null
      this.currentKey = null
      this.currentWxid = null
      this.currentDbStoragePath = null
      this.initialized = false
      this.clearHardlinkCaches()
      this.stopLogPolling()
    }
  }

  /**
   * 关闭服务（与 close 相同）
   */
  shutdown(): void {
    this.close()
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.initialized && this.handle !== null
  }

  async getSessions(): Promise<{ success: boolean; sessions?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      this.writeLog('getSessions skipped: not connected')
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      // 使用 setImmediate 让事件循环有机会处理其他任务，避免长时间阻塞
      await new Promise(resolve => setImmediate(resolve))

      const outPtr = [null as any]
      const result = this.wcdbGetSessions(this.handle, outPtr)

      //数据服务调用后再次让出控制权
      await new Promise(resolve => setImmediate(resolve))

      if (result !== 0 || !outPtr[0]) {
        this.writeLog(`getSessions failed: code=${result}`)
        return { success: false, error: `获取会话失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析会话失败' }
      this.writeLog(`getSessions ok size=${jsonStr.length}`)
      const sessions = JSON.parse(jsonStr)
      return { success: true, sessions }
    } catch (e) {
      this.writeLog(`getSessions exception: ${String(e)}`)
      return { success: false, error: String(e) }
    }
  }

  async getMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMessages(this.handle, sessionId, limit, offset, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取消息失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析消息失败' }
      const messages = this.parseMessageJson(jsonStr)
      return { success: true, messages }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取指定时间之后的新消息
   */
  async getNewMessages(sessionId: string, minTime: number, limit: number = 1000): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      // 1. 打开游标 (使用 Ascending=1 从指定时间往后查)
      const openRes = await this.openMessageCursor(sessionId, limit, true, minTime, 0)
      if (!openRes.success || !openRes.cursor) {
        return { success: false, error: openRes.error }
      }

      const cursor = openRes.cursor
      try {
        // 2. 获取批次
        const fetchRes = await this.fetchMessageBatch(cursor)
        if (!fetchRes.success) {
          return { success: false, error: fetchRes.error }
        }
        return { success: true, messages: fetchRes.rows }
      } finally {
        // 3. 关闭游标
        await this.closeMessageCursor(cursor)
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessageCount(sessionId: string): Promise<{ success: boolean; count?: number; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outCount = [0]
      const result = this.wcdbGetMessageCount(this.handle, sessionId, outCount)
      if (result !== 0) {
        if (result === -7) {
          return { success: false, error: 'message schema mismatch：当前账号消息表结构与程序要求不一致' }
        }
        return { success: false, error: `获取消息总数失败: ${result}` }
      }
      return { success: true, count: outCount[0] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessageCounts(sessionIds: string[]): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }

    const normalizedSessionIds = Array.from(
      new Set(
        (sessionIds || [])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      )
    )
    if (normalizedSessionIds.length === 0) {
      return { success: true, counts: {} }
    }

    try {
      const counts: Record<string, number> = {}
      for (let i = 0; i < normalizedSessionIds.length; i += 1) {
        const sessionId = normalizedSessionIds[i]
        const outCount = [0]
        const result = this.wcdbGetMessageCount(this.handle, sessionId, outCount)
        if (result === -7) {
          return { success: false, error: `message schema mismatch：会话 ${sessionId} 的消息表结构不匹配` }
        }
        counts[sessionId] = result === 0 && Number.isFinite(outCount[0]) ? Math.max(0, Math.floor(outCount[0])) : 0

        if (i > 0 && i % 160 === 0) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }
      return { success: true, counts }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getSessionMessageCounts(sessionIds: string[]): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetSessionMessageCounts) return this.getMessageCounts(sessionIds)
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetSessionMessageCounts(this.handle, JSON.stringify(sessionIds || []), outPtr)
      if (result !== 0 || !outPtr[0]) {
        if (result === -7) {
          return { success: false, error: 'message schema mismatch：当前账号消息表结构与程序要求不一致' }
        }
        return { success: false, error: `获取会话消息总数失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析会话消息总数失败' }
      const raw = JSON.parse(jsonStr) || {}
      const counts: Record<string, number> = {}
      for (const sid of sessionIds || []) {
        const value = Number(raw?.[sid] ?? 0)
        counts[sid] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
      }
      return { success: true, counts }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getSessionMessageTypeStats(
    sessionId: string,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetSessionMessageTypeStats) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetSessionMessageTypeStats(
        this.handle,
        sessionId,
        this.normalizeTimestamp(beginTimestamp),
        this.normalizeTimestamp(endTimestamp),
        outPtr
      )
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取会话类型统计失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析会话类型统计失败' }
      return { success: true, data: JSON.parse(jsonStr) || {} }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getSessionMessageTypeStatsBatch(
    sessionIds: string[],
    options?: {
      beginTimestamp?: number
      endTimestamp?: number
      quickMode?: boolean
      includeGroupSenderCount?: boolean
    }
  ): Promise<{ success: boolean; data?: Record<string, any>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    const normalizedSessionIds = Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
    if (normalizedSessionIds.length === 0) return { success: true, data: {} }

    if (!this.wcdbGetSessionMessageTypeStatsBatch) {
      const data: Record<string, any> = {}
      for (const sessionId of normalizedSessionIds) {
        const single = await this.getSessionMessageTypeStats(
          sessionId,
          options?.beginTimestamp || 0,
          options?.endTimestamp || 0
        )
        if (single.success) {
          data[sessionId] = single.data || {}
        }
      }
      return { success: true, data }
    }

    try {
      const outPtr = [null as any]
      const optionsJson = JSON.stringify({
        begin: this.normalizeTimestamp(options?.beginTimestamp || 0),
        end: this.normalizeTimestamp(options?.endTimestamp || 0),
        quick_mode: options?.quickMode === true,
        include_group_sender_count: options?.includeGroupSenderCount !== false
      })
      const result = this.wcdbGetSessionMessageTypeStatsBatch(
        this.handle,
        JSON.stringify(normalizedSessionIds),
        optionsJson,
        outPtr
      )
      if (result !== 0 || !outPtr[0]) return { success: false, error: `批量获取会话类型统计失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析批量会话类型统计失败' }
      return { success: true, data: JSON.parse(jsonStr) || {} }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getSessionMessageDateCounts(sessionId: string): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetSessionMessageDateCounts) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetSessionMessageDateCounts(this.handle, sessionId, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取会话日消息统计失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析会话日消息统计失败' }
      const raw = JSON.parse(jsonStr) || {}
      const counts: Record<string, number> = {}
      for (const [dateKey, value] of Object.entries(raw)) {
        const count = Number(value)
        if (!dateKey || !Number.isFinite(count) || count <= 0) continue
        counts[String(dateKey)] = Math.floor(count)
      }
      return { success: true, counts }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getSessionMessageDateCountsBatch(sessionIds: string[]): Promise<{ success: boolean; data?: Record<string, Record<string, number>>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    const normalizedSessionIds = Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
    if (normalizedSessionIds.length === 0) return { success: true, data: {} }

    if (!this.wcdbGetSessionMessageDateCountsBatch) {
      const data: Record<string, Record<string, number>> = {}
      for (const sessionId of normalizedSessionIds) {
        const single = await this.getSessionMessageDateCounts(sessionId)
        data[sessionId] = single.success && single.counts ? single.counts : {}
      }
      return { success: true, data }
    }

    try {
      const outPtr = [null as any]
      const result = this.wcdbGetSessionMessageDateCountsBatch(this.handle, JSON.stringify(normalizedSessionIds), outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `批量获取会话日消息统计失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析批量会话日消息统计失败' }
      const raw = JSON.parse(jsonStr) || {}
      const data: Record<string, Record<string, number>> = {}
      for (const sessionId of normalizedSessionIds) {
        const source = raw?.[sessionId] || {}
        const next: Record<string, number> = {}
        for (const [dateKey, value] of Object.entries(source)) {
          const count = Number(value)
          if (!dateKey || !Number.isFinite(count) || count <= 0) continue
          next[String(dateKey)] = Math.floor(count)
        }
        data[sessionId] = next
      }
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessagesByType(
    sessionId: string,
    localType: number,
    ascending = false,
    limit = 0,
    offset = 0
  ): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetMessagesByType) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMessagesByType(
        this.handle,
        sessionId,
        BigInt(localType),
        ascending ? 1 : 0,
        Math.max(0, Math.floor(limit || 0)),
        Math.max(0, Math.floor(offset || 0)),
        outPtr
      )
      if (result !== 0 || !outPtr[0]) return { success: false, error: `按类型读取消息失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析按类型消息失败' }
      const rows = JSON.parse(jsonStr)
      return { success: true, rows: Array.isArray(rows) ? rows : [] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMediaStream(options?: {
    sessionId?: string
    mediaType?: 'image' | 'video' | 'all'
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }): Promise<{
    success: boolean
    items?: Array<{
      sessionId: string
      sessionDisplayName?: string
      mediaType: 'image' | 'video'
      localId: number
      serverId?: string
      createTime: number
      localType: number
      senderUsername?: string
      isSend?: number | null
      imageMd5?: string
      imageDatName?: string
      videoMd5?: string
      content?: string
    }>
    hasMore?: boolean
    nextOffset?: number
    error?: string
  }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbScanMediaStream) return { success: false, error: '当前数据服务版本不支持媒体流扫描，请先更新 wcdb 数据服务' }
    try {
      const toInt = (value: unknown): number => {
        const n = Number(value || 0)
        if (!Number.isFinite(n)) return 0
        return Math.floor(n)
      }
      const pickString = (row: Record<string, any>, keys: string[]): string => {
        for (const key of keys) {
          const value = row[key]
          if (value === null || value === undefined) continue
          const text = String(value).trim()
          if (text) return text
        }
        return ''
      }
      const extractXmlValue = (xml: string, tag: string): string => {
        if (!xml) return ''
        const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i')
        const match = regex.exec(xml)
        if (!match) return ''
        return String(match[1] || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
      }
      const looksLikeHex = (text: string): boolean => {
        if (!text || text.length < 2 || text.length % 2 !== 0) return false
        return /^[0-9a-fA-F]+$/.test(text)
      }
      const looksLikeBase64 = (text: string): boolean => {
        if (!text || text.length < 16 || text.length % 4 !== 0) return false
        return /^[A-Za-z0-9+/]+={0,2}$/.test(text)
      }
      const decodeBinaryContent = (data: Buffer, fallbackValue?: string): string => {
        if (!data || data.length === 0) return ''
        try {
          if (data.length >= 4) {
            const magicLE = data.readUInt32LE(0)
            const magicBE = data.readUInt32BE(0)
            if (magicLE === 0xFD2FB528 || magicBE === 0xFD2FB528) {
              try {
                const decompressed = fzstd.decompress(data)
                return Buffer.from(decompressed).toString('utf-8')
              } catch {
                // ignore
              }
            }
          }
          const decoded = data.toString('utf-8')
          const replacementCount = (decoded.match(/\uFFFD/g) || []).length
          if (replacementCount < decoded.length * 0.2) {
            return decoded.replace(/\uFFFD/g, '')
          }
          if (fallbackValue && replacementCount > 0) return fallbackValue
          return data.toString('latin1')
        } catch {
          return fallbackValue || ''
        }
      }
      const decodeMaybeCompressed = (raw: unknown): string => {
        if (raw === null || raw === undefined) return ''
        if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
          return decodeBinaryContent(Buffer.from(raw as any), String(raw))
        }
        const text = String(raw).trim()
        if (!text) return ''

        if (text.length > 16 && looksLikeHex(text)) {
          try {
            const bytes = Buffer.from(text, 'hex')
            if (bytes.length > 0) return decodeBinaryContent(bytes, text)
          } catch {
            // ignore
          }
        }
        if (text.length > 16 && looksLikeBase64(text)) {
          try {
            const bytes = Buffer.from(text, 'base64')
            if (bytes.length > 0) return decodeBinaryContent(bytes, text)
          } catch {
            // ignore
          }
        }
        return text
      }
      const decodeMessageContent = (messageContent: unknown, compressContent: unknown): string => {
        const compressedDecoded = decodeMaybeCompressed(compressContent)
        if (compressedDecoded) return compressedDecoded
        return decodeMaybeCompressed(messageContent)
      }
      const extractImageMd5 = (xml: string): string => {
        const byTag = extractXmlValue(xml, 'md5') || extractXmlValue(xml, 'imgmd5')
        if (byTag) return byTag
        const byAttr = /(?:md5|imgmd5)\s*=\s*['"]?([a-fA-F0-9]{16,64})['"]?/i.exec(xml)
        return byAttr?.[1] || ''
      }
      const normalizeDatBase = (value: string): string => {
        const input = String(value || '').trim()
        if (!input) return ''
        const fileBase = input.replace(/^.*[\\/]/, '').replace(/\.(?:t\.)?dat$/i, '')
        const md5Like = /([0-9a-fA-F]{16,64})/.exec(fileBase)
        return String(md5Like?.[1] || fileBase || '').trim().toLowerCase()
      }
      const decodePackedToPrintable = (raw: string): string => {
        const text = String(raw || '').trim()
        if (!text) return ''
        let buf: Buffer | null = null
        if (/^[a-fA-F0-9]+$/.test(text) && text.length % 2 === 0) {
          try {
            buf = Buffer.from(text, 'hex')
          } catch {
            buf = null
          }
        }
        if (!buf) {
          try {
            const base64 = Buffer.from(text, 'base64')
            if (base64.length > 0) buf = base64
          } catch {
            buf = null
          }
        }
        if (!buf || buf.length === 0) return ''
        const printable: number[] = []
        for (const byte of buf) {
          if (byte >= 0x20 && byte <= 0x7e) printable.push(byte)
          else printable.push(0x20)
        }
        return Buffer.from(printable).toString('utf-8')
      }
      const extractHexMd5 = (text: string): string => {
        const input = String(text || '')
        if (!input) return ''
        const match = /([a-fA-F0-9]{32})/.exec(input)
        return String(match?.[1] || '').toLowerCase()
      }
      const extractImageDatName = (row: Record<string, any>, content: string): string => {
        const direct = pickString(row, [
          'image_path',
          'imagePath',
          'image_dat_name',
          'imageDatName',
          'img_path',
          'imgPath',
          'img_name',
          'imgName'
        ])
        const normalizedDirect = normalizeDatBase(direct)
        if (normalizedDirect) return normalizedDirect

        const xmlCandidate = extractXmlValue(content, 'imgname') || extractXmlValue(content, 'cdnmidimgurl')
        const normalizedXml = normalizeDatBase(xmlCandidate)
        if (normalizedXml) return normalizedXml

        const packedRaw = pickString(row, [
          'packed_info_data',
          'packedInfoData',
          'packed_info_blob',
          'packedInfoBlob',
          'packed_info',
          'packedInfo',
          'BytesExtra',
          'bytes_extra',
          'WCDB_CT_packed_info',
          'reserved0',
          'Reserved0',
          'WCDB_CT_Reserved0'
        ])
        const packedText = decodePackedToPrintable(packedRaw)
        if (packedText) {
          const datLike = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/i.exec(packedText)
          if (datLike?.[1]) return String(datLike[1]).toLowerCase()
          const md5Like = /([0-9a-fA-F]{16,64})/.exec(packedText)
          if (md5Like?.[1]) return String(md5Like[1]).toLowerCase()
        }

        return ''
      }
      const extractPackedPayload = (row: Record<string, any>): string => {
        const packedRaw = pickString(row, [
          'packed_info_data',
          'packedInfoData',
          'packed_info_blob',
          'packedInfoBlob',
          'packed_info',
          'packedInfo',
          'BytesExtra',
          'bytes_extra',
          'WCDB_CT_packed_info',
          'reserved0',
          'Reserved0',
          'WCDB_CT_Reserved0'
        ])
        return decodePackedToPrintable(packedRaw)
      }
      const extractVideoMd5 = (xml: string): string => {
        const byTag =
          extractXmlValue(xml, 'rawmd5') ||
          extractXmlValue(xml, 'videomd5') ||
          extractXmlValue(xml, 'newmd5') ||
          extractXmlValue(xml, 'md5')
        if (byTag) return byTag
        const byAttr = /(?:rawmd5|videomd5|newmd5|md5)\s*=\s*['"]?([a-fA-F0-9]{16,64})['"]?/i.exec(xml)
        return byAttr?.[1] || ''
      }

      const requestedSessionId = String(options?.sessionId || '').trim()
      const mediaType = String(options?.mediaType || 'all').trim() as 'image' | 'video' | 'all'
      const beginTimestamp = Math.max(0, toInt(options?.beginTimestamp))
      const endTimestamp = Math.max(0, toInt(options?.endTimestamp))
      const offset = Math.max(0, toInt(options?.offset))
      const limit = Math.min(1200, Math.max(40, toInt(options?.limit) || 240))

      const sessionsRes = await this.getSessions()
      if (!sessionsRes.success || !Array.isArray(sessionsRes.sessions)) {
        return { success: false, error: sessionsRes.error || '读取会话失败' }
      }

      const sessions = (sessionsRes.sessions || [])
        .map((row: any) => ({
          sessionId: String(
            row.username ||
            row.user_name ||
            row.userName ||
            row.usrName ||
            row.UsrName ||
            row.talker ||
            ''
          ).trim(),
          displayName: String(row.displayName || row.display_name || row.remark || '').trim(),
          sortTimestamp: toInt(
            row.sort_timestamp ||
            row.sortTimestamp ||
            row.last_timestamp ||
            row.lastTimestamp ||
            0
          )
        }))
        .filter((row) => Boolean(row.sessionId))
        .sort((a, b) => b.sortTimestamp - a.sortTimestamp)

      const sessionRows = requestedSessionId
        ? sessions.filter((row) => row.sessionId === requestedSessionId)
        : sessions
      if (sessionRows.length === 0) {
        return { success: true, items: [], hasMore: false, nextOffset: offset }
      }
      const sessionNameMap = new Map(sessionRows.map((row) => [row.sessionId, row.displayName || row.sessionId]))

      const outPtr = [null as any]
      const outHasMore = [0]
      const mediaTypeCode = mediaType === 'image' ? 1 : mediaType === 'video' ? 2 : 0
      const result = this.wcdbScanMediaStream(
        this.handle,
        JSON.stringify(sessionRows.map((row) => row.sessionId)),
        mediaTypeCode,
        beginTimestamp,
        endTimestamp,
        limit,
        offset,
        outPtr,
        outHasMore
      )
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `扫描媒体流失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析媒体流失败' }
      const rows = JSON.parse(jsonStr)
      const list = Array.isArray(rows) ? rows as Array<Record<string, any>> : []

      let items = list.map((row) => {
        const sessionId = pickString(row, ['session_id', 'sessionId']) || requestedSessionId
        const localType = toInt(row.local_type ?? row.localType)
        const rawMessageContent = pickString(row, [
          'message_content',
          'messageContent',
          'message_content_text',
          'messageText',
          'StrContent',
          'str_content',
          'msg_content',
          'msgContent',
          'strContent',
          'content',
          'rawContent',
          'WCDB_CT_message_content'
        ])
        const rawCompressContent = pickString(row, [
          'compress_content',
          'compressContent',
          'msg_compress_content',
          'msgCompressContent',
          'WCDB_CT_compress_content'
        ])
        const useRawMessageContent = Boolean(
          rawMessageContent &&
          (rawMessageContent.includes('<') || rawMessageContent.includes('md5') || rawMessageContent.includes('videomsg'))
        )
        const content = useRawMessageContent
          ? rawMessageContent
          : decodeMessageContent(rawMessageContent, rawCompressContent)
        const packedPayload = extractPackedPayload(row)
        const imageMd5ByColumn = pickString(row, ['image_md5', 'imageMd5'])
        const imageMd5 = localType === 3
          ? (imageMd5ByColumn || extractImageMd5(content) || extractHexMd5(packedPayload) || undefined)
          : undefined
        const imageDatName = localType === 3 ? (extractImageDatName(row, content) || undefined) : undefined
        const videoMd5ByColumn = pickString(row, ['video_md5', 'videoMd5', 'raw_md5', 'rawMd5'])
        const videoMd5 = localType === 43
          ? (videoMd5ByColumn || extractVideoMd5(content) || extractHexMd5(packedPayload) || undefined)
          : undefined
        return {
          sessionId,
          sessionDisplayName: sessionNameMap.get(sessionId) || sessionId,
          mediaType: localType === 43 ? 'video' as const : 'image' as const,
          localId: toInt(row.local_id ?? row.localId),
          serverId: pickString(row, ['server_id', 'serverId']) || undefined,
          createTime: toInt(row.create_time ?? row.createTime),
          localType,
          senderUsername: pickString(row, ['sender_username', 'senderUsername']) || undefined,
          isSend: row.is_send === null || row.is_send === undefined ? null : toInt(row.is_send),
          imageMd5,
          imageDatName,
          videoMd5,
          content: content || undefined
        }
      })

      const unresolvedSessionIds = Array.from(
        new Set(
          items
            .map((item) => item.sessionId)
            .filter((sessionId) => {
              const name = String(sessionNameMap.get(sessionId) || '').trim()
              return !name || name === sessionId
            })
        )
      )
      if (unresolvedSessionIds.length > 0) {
        const displayNameRes = await this.getDisplayNames(unresolvedSessionIds)
        if (displayNameRes.success && displayNameRes.map) {
          unresolvedSessionIds.forEach((sessionId) => {
            const display = String(displayNameRes.map?.[sessionId] || '').trim()
            if (display) sessionNameMap.set(sessionId, display)
          })
          items = items.map((item) => ({
            ...item,
            sessionDisplayName: sessionNameMap.get(item.sessionId) || item.sessionId
          }))
        }
      }

      return {
        success: true,
        items,
        hasMore: Number(outHasMore[0]) > 0,
        nextOffset: offset + items.length
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getDisplayNames(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (usernames.length === 0) return { success: true, map: {} }
    try {
      if (process.platform === 'darwin') {
        const uniq = Array.from(new Set(usernames.map((x) => String(x || '').trim()).filter(Boolean)))
        if (uniq.length === 0) return { success: true, map: {} }
        const inList = uniq.map((u) => `'${u.replace(/'/g, "''")}'`).join(',')
        const sql = `SELECT * FROM contact WHERE username IN (${inList})`
        const q = await this.execQuery('contact', null, sql)
        if (!q.success) return { success: false, error: q.error || '获取昵称失败' }
        const map: Record<string, string> = {}
        for (const row of (q.rows || []) as Array<Record<string, any>>) {
          const username = this.pickFirstStringField(row, ['username', 'user_name', 'userName'])
          if (!username) continue
          const display = this.pickFirstStringField(row, [
            'remark', 'Remark',
            'nick_name', 'nickName', 'nickname', 'NickName',
            'alias', 'Alias'
          ]) || username
          map[username] = display
        }
        // 保证每个请求用户名至少有回退值
        for (const u of uniq) {
          if (!map[u]) map[u] = u
        }
        return { success: true, map }
      }

      // 让出控制权，避免阻塞事件循环
      await new Promise(resolve => setImmediate(resolve))

      const outPtr = [null as any]
      const result = this.wcdbGetDisplayNames(this.handle, JSON.stringify(usernames), outPtr)

      //数据服务调用后再次让出控制权
      await new Promise(resolve => setImmediate(resolve))

      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取昵称失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析昵称失败' }
      const map = JSON.parse(jsonStr)
      return { success: true, map }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getAvatarUrls(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (usernames.length === 0) return { success: true, map: {} }
    try {
      const now = Date.now()
      const resultMap: Record<string, string> = {}
      const toFetch: string[] = []
      const seen = new Set<string>()

      for (const username of usernames) {
        if (!username || seen.has(username)) continue
        seen.add(username)
        const cached = this.avatarUrlCache.get(username)
        // 只使用有效的缓存(URL不为空)
        if (cached && cached.url && cached.url.trim() && now - cached.updatedAt < this.avatarCacheTtlMs) {
          resultMap[username] = cached.url
          continue
        }
        toFetch.push(username)
      }

      if (toFetch.length === 0) {
        return { success: true, map: resultMap }
      }

      if (process.platform === 'darwin') {
        const inList = toFetch.map((u) => `'${u.replace(/'/g, "''")}'`).join(',')
        const sql = `SELECT * FROM contact WHERE username IN (${inList})`
        const q = await this.execQuery('contact', null, sql)
        if (!q.success) {
          if (Object.keys(resultMap).length > 0) {
            return { success: true, map: resultMap, error: q.error || '获取头像失败' }
          }
          return { success: false, error: q.error || '获取头像失败' }
        }

        for (const row of (q.rows || []) as Array<Record<string, any>>) {
          const username = this.pickFirstStringField(row, ['username', 'user_name', 'userName'])
          if (!username) continue
          const url = this.pickFirstStringField(row, [
            'big_head_img_url', 'bigHeadImgUrl', 'bigHeadUrl', 'big_head_url',
            'small_head_img_url', 'smallHeadImgUrl', 'smallHeadUrl', 'small_head_url',
            'head_img_url', 'headImgUrl',
            'avatar_url', 'avatarUrl'
          ])
          if (url) {
            resultMap[username] = url
            this.avatarUrlCache.set(username, { url, updatedAt: now })
          }
        }
        return { success: true, map: resultMap }
      }

      // 让出控制权，避免阻塞事件循环
      const handle = this.handle
      await new Promise(resolve => setImmediate(resolve))

      // await 后 handle 可能已被关闭，需重新检查
      if (handle === null || this.handle !== handle) {
        if (Object.keys(resultMap).length > 0) {
          return { success: true, map: resultMap, error: '连接已断开' }
        }
        return { success: false, error: '连接已断开' }
      }

      const outPtr = [null as any]
      const result = this.wcdbGetAvatarUrls(handle, JSON.stringify(toFetch), outPtr)

      //数据服务调用后再次让出控制权
      await new Promise(resolve => setImmediate(resolve))

      if (result !== 0 || !outPtr[0]) {
        if (Object.keys(resultMap).length > 0) {
          return { success: true, map: resultMap, error: `获取头像失败: ${result}` }
        }
        return { success: false, error: `获取头像失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) {
        return { success: false, error: '解析头像失败' }
      }
      const map = JSON.parse(jsonStr) as Record<string, string>
      for (const username of toFetch) {
        const url = map[username]
        if (url && url.trim()) {
          resultMap[username] = url
          // 只缓存有效的URL
          this.avatarUrlCache.set(username, { url, updatedAt: now })
        }
        // 不缓存空URL,下次可以重新尝试
      }
      return { success: true, map: resultMap }
    } catch (e) {
      console.error('[wcdbCore] getAvatarUrls 异常:', e)
      return { success: false, error: String(e) }
    }
  }

  async getGroupMemberCount(chatroomId: string): Promise<{ success: boolean; count?: number; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outCount = [0]
      const result = this.wcdbGetGroupMemberCount(this.handle, chatroomId, outCount)
      if (result !== 0) {
        return { success: false, error: `获取群成员数量失败: ${result}` }
      }
      return { success: true, count: outCount[0] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMemberCounts(chatroomIds: string[]): Promise<{ success: boolean; map?: Record<string, number>; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (chatroomIds.length === 0) return { success: true, map: {} }
    if (!this.wcdbGetGroupMemberCounts) {
      const map: Record<string, number> = {}
      for (const chatroomId of chatroomIds) {
        const result = await this.getGroupMemberCount(chatroomId)
        if (result.success && typeof result.count === 'number') {
          map[chatroomId] = result.count
        }
      }
      return { success: true, map }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetGroupMemberCounts(this.handle, JSON.stringify(chatroomIds), outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取群成员数量失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析群成员数量失败' }
      const map = JSON.parse(jsonStr)
      return { success: true, map }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMembers(chatroomId: string): Promise<{ success: boolean; members?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetGroupMembers(this.handle, chatroomId, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取群成员失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析群成员失败' }
      const members = JSON.parse(jsonStr)
      return { success: true, members }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupNicknames(chatroomId: string): Promise<{ success: boolean; nicknames?: Record<string, string>; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetGroupNicknames) {
      return { success: false, error: '当前数据服务版本不支持获取群昵称接口' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetGroupNicknames(this.handle, chatroomId, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取群昵称失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析群昵称失败' }
      const nicknames = JSON.parse(jsonStr)
      return { success: true, nicknames }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessageTables(sessionId: string): Promise<{ success: boolean; tables?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMessageTables(this.handle, sessionId, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取消息表失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析消息表失败' }
      const tables = JSON.parse(jsonStr)
      return { success: true, tables }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessageDates(sessionId: string): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      if (!this.wcdbGetMessageDates) {
        return { success: false, error: 'DLL 不支持 getMessageDates' }
      }
      const outPtr = [null as any]
      const result = this.wcdbGetMessageDates(this.handle, sessionId, outPtr)
      if (result !== 0 || !outPtr[0]) {
        // 空结果也可能是正常的（无消息）
        return { success: true, dates: [] }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析日期列表失败' }
      const dates = JSON.parse(jsonStr)
      return { success: true, dates }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessageTableStats(sessionId: string): Promise<{ success: boolean; tables?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMessageTableStats(this.handle, sessionId, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取表统计失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析表统计失败' }
      const tables = JSON.parse(jsonStr)
      return { success: true, tables }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessageMeta(dbPath: string, tableName: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMessageMeta(this.handle, dbPath, tableName, limit, offset, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取消息元数据失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析消息元数据失败' }
      const rows = JSON.parse(jsonStr)
      return { success: true, rows }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getContact(username: string): Promise<{ success: boolean; contact?: any; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      if (process.platform === 'darwin') {
        const safe = String(username || '').replace(/'/g, "''")
        const sql = `SELECT * FROM contact WHERE username='${safe}' LIMIT 1`
        const q = await this.execQuery('contact', null, sql)
        if (!q.success) {
          return { success: false, error: q.error || '获取联系人失败' }
        }
        const row = Array.isArray(q.rows) && q.rows.length > 0 ? q.rows[0] : null
        if (!row) {
          return { success: false, error: `联系人不存在: ${username}` }
        }
        return { success: true, contact: row }
      }

      const outPtr = [null as any]
      const result = this.wcdbGetContact(this.handle, username, outPtr)
      if (result !== 0 || !outPtr[0]) {
        this.writeLog(`[diag:getContact] primary api failed username=${username} code=${result} outPtr=${outPtr[0] ? 'set' : 'null'}`, true)
        await this.dumpDbStatus('getContact-primary-fail')
        await this.printLogs(true)

        // Fallback: 直接查询 contact 表，便于区分是接口失败还是 contact 库本身不可读。
        const safe = String(username || '').replace(/'/g, "''")
        const fallbackSql = `SELECT * FROM contact WHERE username='${safe}' LIMIT 1`
        const fallback = await this.execQuery('contact', null, fallbackSql)
        if (fallback.success) {
          const row = Array.isArray(fallback.rows) ? fallback.rows[0] : null
          if (row) {
            this.writeLog(`[diag:getContact] fallback sql hit username=${username}`, true)
            return { success: true, contact: row }
          }
          this.writeLog(`[diag:getContact] fallback sql no row username=${username}`, true)
          return { success: false, error: `联系人不存在: ${username}` }
        }
        this.writeLog(`[diag:getContact] fallback sql failed username=${username} err=${fallback.error || 'unknown'}`, true)
        return { success: false, error: `获取联系人失败: ${result}; fallback=${fallback.error || 'unknown'}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析联系人失败' }
      const contact = JSON.parse(jsonStr)
      return { success: true, contact }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getContactStatus(usernames: string[]): Promise<{ success: boolean; map?: Record<string, { isFolded: boolean; isMuted: boolean }>; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetContactStatus) {
      return { success: false, error: '接口未就绪' }
    }
    try {
      const outPtr = [null as any]
      const code = this.wcdbGetContactStatus(this.handle, JSON.stringify(usernames || []), outPtr)
      if (code !== 0 || !outPtr[0]) {
        return { success: false, error: `获取会话状态失败: ${code}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析会话状态失败' }

      const rawMap = JSON.parse(jsonStr) || {}
      const map: Record<string, { isFolded: boolean; isMuted: boolean }> = {}
      for (const username of usernames || []) {
        const state = rawMap[username] || {}
        map[username] = {
          isFolded: Boolean(state.isFolded),
          isMuted: Boolean(state.isMuted)
        }
      }
      return { success: true, map }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessageTableColumns(dbPath: string, tableName: string): Promise<{ success: boolean; columns?: string[]; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetMessageTableColumns) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMessageTableColumns(this.handle, dbPath, tableName, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取消息表列失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析消息表列失败' }
      const columns = JSON.parse(jsonStr)
      return { success: true, columns: Array.isArray(columns) ? columns.map((c: any) => String(c || '')) : [] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMessageTableTimeRange(dbPath: string, tableName: string): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetMessageTableTimeRange) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMessageTableTimeRange(this.handle, dbPath, tableName, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取消息表时间范围失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析消息表时间范围失败' }
      const data = JSON.parse(jsonStr) || {}
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getContactTypeCounts(): Promise<{ success: boolean; counts?: { private: number; group: number; official: number; former_friend: number }; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    const runFallback = async (reason: string) => {
      const contactsResult = await this.getContactsCompact()
      if (!contactsResult.success || !Array.isArray(contactsResult.contacts)) {
        return { success: false, error: `获取联系人分类统计失败: ${reason}; fallback=${contactsResult.error || 'unknown'}` }
      }
      const counts = this.deriveContactTypeCounts(contactsResult.contacts as Array<Record<string, any>>)
      this.writeLog(`[diag:getContactTypeCounts] fallback reason=${reason} private=${counts.private} group=${counts.group} official=${counts.official} former_friend=${counts.former_friend}`, true)
      return { success: true, counts }
    }

    if (!this.wcdbGetContactTypeCounts) return await runFallback('api_missing')
    try {
      const outPtr = [null as any]
      const code = this.wcdbGetContactTypeCounts(this.handle, outPtr)
      if (code !== 0 || !outPtr[0]) return await runFallback(`code=${code}`)
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return await runFallback('decode_empty')
      const raw = JSON.parse(jsonStr) || {}
      return {
        success: true,
        counts: {
          private: Number(raw.private || 0),
          group: Number(raw.group || 0),
          official: Number(raw.official || 0),
          former_friend: Number(raw.former_friend || 0)
        }
      }
    } catch (e) {
      return await runFallback(`exception=${String(e)}`)
    }
  }

  async getContactsCompact(usernames: string[] = []): Promise<{ success: boolean; contacts?: any[]; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    const runFallback = async (reason: string) => {
      const fallback = await this.execQuery('contact', null, this.buildContactSelectSql(usernames))
      if (!fallback.success) {
        return { success: false, error: `获取联系人列表失败: ${reason}; fallback=${fallback.error || 'unknown'}` }
      }
      const rows = Array.isArray(fallback.rows) ? fallback.rows : []
      this.writeLog(`[diag:getContactsCompact] fallback reason=${reason} usernames=${Array.isArray(usernames) ? usernames.length : 0} rows=${rows.length}`, true)
      return { success: true, contacts: rows }
    }

    if (!this.wcdbGetContactsCompact) return await runFallback('api_missing')
    try {
      const outPtr = [null as any]
      const payload = Array.isArray(usernames) && usernames.length > 0 ? JSON.stringify(usernames) : null
      const code = this.wcdbGetContactsCompact(this.handle, payload, outPtr)
      if (code !== 0 || !outPtr[0]) return await runFallback(`code=${code}`)
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return await runFallback('decode_empty')
      const contacts = JSON.parse(jsonStr)
      return { success: true, contacts: Array.isArray(contacts) ? contacts : [] }
    } catch (e) {
      return await runFallback(`exception=${String(e)}`)
    }
  }

  async getContactAliasMap(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetContactAliasMap) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const code = this.wcdbGetContactAliasMap(this.handle, JSON.stringify(usernames || []), outPtr)
      if (code !== 0 || !outPtr[0]) return { success: false, error: `获取联系人 alias 失败: ${code}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析联系人 alias 失败' }
      const map = JSON.parse(jsonStr)
      return { success: true, map }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getContactFriendFlags(usernames: string[]): Promise<{ success: boolean; map?: Record<string, boolean>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetContactFriendFlags) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const code = this.wcdbGetContactFriendFlags(this.handle, JSON.stringify(usernames || []), outPtr)
      if (code !== 0 || !outPtr[0]) return { success: false, error: `获取联系人好友标记失败: ${code}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析联系人好友标记失败' }
      const map = JSON.parse(jsonStr)
      return { success: true, map }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getChatRoomExtBuffer(chatroomId: string): Promise<{ success: boolean; extBuffer?: string; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetChatRoomExtBuffer) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const code = this.wcdbGetChatRoomExtBuffer(this.handle, chatroomId, outPtr)
      if (code !== 0 || !outPtr[0]) return { success: false, error: `获取群聊 ext_buffer 失败: ${code}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析群聊 ext_buffer 失败' }
      const data = JSON.parse(jsonStr) || {}
      const extBuffer = String(data.ext_buffer || '').trim()
      return { success: true, extBuffer: extBuffer || undefined }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getAggregateStats(sessionIds: string[], beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const normalizedBegin = this.normalizeTimestamp(beginTimestamp)
      let normalizedEnd = this.normalizeTimestamp(endTimestamp)
      if (normalizedEnd <= 0) {
        normalizedEnd = this.normalizeTimestamp(Date.now())
      }
      if (normalizedBegin > 0 && normalizedEnd < normalizedBegin) {
        normalizedEnd = normalizedBegin
      }

      const callAggregate = (ids: string[]) => {
        const idsAreNumeric = ids.length > 0 && ids.every((id) => /^\d+$/.test(id))
        const payloadIds = idsAreNumeric ? ids.map((id) => Number(id)) : ids

        const outPtr = [null as any]
        const result = this.wcdbGetAggregateStats(this.handle, JSON.stringify(payloadIds), normalizedBegin, normalizedEnd, outPtr)

        if (result !== 0 || !outPtr[0]) {
          return { success: false, error: `获取聚合统计失败: ${result}` }
        }
        const jsonStr = this.decodeJsonPtr(outPtr[0])
        if (!jsonStr) {
          return { success: false, error: '解析聚合统计失败' }
        }

        const data = JSON.parse(jsonStr)
        return { success: true, data }
      }

      let result = callAggregate(sessionIds)
      if (result.success && result.data && result.data.total === 0 && result.data.idMap) {
        const idMap = result.data.idMap as Record<string, string>
        const reverseMap: Record<string, string> = {}
        for (const [id, name] of Object.entries(idMap)) {
          if (!name) continue
          reverseMap[name] = id
        }
        const numericIds = sessionIds
          .map((id) => reverseMap[id])
          .filter((id) => typeof id === 'string' && /^\d+$/.test(id))
        if (numericIds.length > 0) {
          const retry = callAggregate(numericIds)
          if (retry.success && retry.data) {
            result = retry
          }
        }
      }

      return result
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getAvailableYears(sessionIds: string[]): Promise<{ success: boolean; data?: number[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetAvailableYears) {
      return { success: false, error: '未支持获取年度列表' }
    }
    if (sessionIds.length === 0) return { success: true, data: [] }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetAvailableYears(this.handle, JSON.stringify(sessionIds), outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取年度列表失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析年度列表失败' }
      const data = JSON.parse(jsonStr)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getAnnualReportStats(sessionIds: string[], beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetAnnualReportStats) {
      return this.getAggregateStats(sessionIds, beginTimestamp, endTimestamp)
    }
    try {
      const { begin, end } = this.normalizeRange(beginTimestamp, endTimestamp)
      const outPtr = [null as any]
      const result = this.wcdbGetAnnualReportStats(this.handle, JSON.stringify(sessionIds), begin, end, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取年度统计失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析年度统计失败' }
      const data = JSON.parse(jsonStr)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getAnnualReportExtras(
    sessionIds: string[],
    beginTimestamp: number = 0,
    endTimestamp: number = 0,
    peakDayBegin: number = 0,
    peakDayEnd: number = 0
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetAnnualReportExtras) {
      return { success: false, error: '未支持年度扩展统计' }
    }
    if (sessionIds.length === 0) return { success: true, data: {} }
    try {
      const { begin, end } = this.normalizeRange(beginTimestamp, endTimestamp)
      const outPtr = [null as any]
      const result = this.wcdbGetAnnualReportExtras(
        this.handle,
        JSON.stringify(sessionIds),
        begin,
        end,
        this.normalizeTimestamp(peakDayBegin),
        this.normalizeTimestamp(peakDayEnd),
        outPtr
      )
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取年度扩展统计失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析年度扩展统计失败' }
      const data = JSON.parse(jsonStr)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupStats(chatroomId: string, beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetGroupStats) {
      return this.getAggregateStats([chatroomId], beginTimestamp, endTimestamp)
    }
    try {
      const { begin, end } = this.normalizeRange(beginTimestamp, endTimestamp)
      const outPtr = [null as any]
      const result = this.wcdbGetGroupStats(this.handle, chatroomId, begin, end, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取群聊统计失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析群聊统计失败' }
      const data = JSON.parse(jsonStr)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 强制重新打开账号连接（绕过路径缓存），用于微信重装后消息数据库刷新失败时的自动恢复。
   * 返回重新打开是否成功。
   */
  private async forceReopen(): Promise<boolean> {
    if (!this.currentPath || !this.currentKey || !this.currentWxid) return false
    const path = this.currentPath
    const key = this.currentKey
    const wxid = this.currentWxid
    this.writeLog('forceReopen: clearing cached handle and reopening...', true)
    // 清空缓存状态，让 open() 真正重新打开
    try { this.wcdbShutdown() } catch { }
    this.handle = null
    this.currentPath = null
    this.currentKey = null
    this.currentWxid = null
    this.currentDbStoragePath = null
    this.initialized = false
    return this.open(path, key, wxid)
  }

  async openMessageCursor(sessionId: string, batchSize: number, ascending: boolean, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; cursor?: number; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outCursor = [0]
      let result = this.wcdbOpenMessageCursor(
        this.handle,
        sessionId,
        batchSize,
        ascending ? 1 : 0,
        beginTimestamp,
        endTimestamp,
        outCursor
      )
      // result=-3 表示 WCDB_STATUS_NO_MESSAGE_DB：消息数据库缓存为空（常见于微信重装后）
      // 自动强制重连并重试一次
      if (result === -3 && outCursor[0] <= 0) {
        this.writeLog('openMessageCursor: result=-3 (no message db), attempting forceReopen...', true)
        const reopened = await this.forceReopen()
        if (reopened && this.handle !== null) {
          outCursor[0] = 0
          result = this.wcdbOpenMessageCursor(
            this.handle,
            sessionId,
            batchSize,
            ascending ? 1 : 0,
            beginTimestamp,
            endTimestamp,
            outCursor
          )
          this.writeLog(`openMessageCursor retry after forceReopen: result=${result} cursor=${outCursor[0]}`, true)
        } else {
          this.writeLog('openMessageCursor forceReopen failed, giving up', true)
        }
      }
      if (result !== 0 || outCursor[0] <= 0) {
        await this.printLogs(true)
        this.writeLog(
          `openMessageCursor failed: sessionId=${sessionId} batchSize=${batchSize} ascending=${ascending ? 1 : 0} begin=${beginTimestamp} end=${endTimestamp} result=${result} cursor=${outCursor[0]}`,
          true
        )
        const hint = result === -3
          ? `创建游标失败: ${result}（消息数据库未找到）。如果你最近重装过微信，请尝试重新指定数据目录后重试`
          : result === -7
            ? 'message schema mismatch：当前账号消息表结构与程序要求不一致'
            : `创建游标失败: ${result}，请查看日志`
        return { success: false, error: hint }
      }
      return { success: true, cursor: outCursor[0] }
    } catch (e) {
      await this.printLogs(true)
      this.writeLog(`openMessageCursor exception: ${String(e)}`, true)
      return { success: false, error: '创建游标异常，请查看日志' }
    }
  }

  async openMessageCursorLite(sessionId: string, batchSize: number, ascending: boolean, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; cursor?: number; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbOpenMessageCursorLite) {
      return this.openMessageCursor(sessionId, batchSize, ascending, beginTimestamp, endTimestamp)
    }
    try {
      const outCursor = [0]
      let result = this.wcdbOpenMessageCursorLite(
        this.handle,
        sessionId,
        batchSize,
        ascending ? 1 : 0,
        beginTimestamp,
        endTimestamp,
        outCursor
      )

      // result=-3 表示 WCDB_STATUS_NO_MESSAGE_DB：消息数据库缓存为空
      // 自动强制重连并重试一次
      if (result === -3 && outCursor[0] <= 0) {
        this.writeLog('openMessageCursorLite: result=-3 (no message db), attempting forceReopen...', true)
        const reopened = await this.forceReopen()
        if (reopened && this.handle !== null) {
          outCursor[0] = 0
          result = this.wcdbOpenMessageCursorLite(
            this.handle,
            sessionId,
            batchSize,
            ascending ? 1 : 0,
            beginTimestamp,
            endTimestamp,
            outCursor
          )
          this.writeLog(`openMessageCursorLite retry after forceReopen: result=${result} cursor=${outCursor[0]}`, true)
        } else {
          this.writeLog('openMessageCursorLite forceReopen failed, giving up', true)
        }
      }

      if (result !== 0 || outCursor[0] <= 0) {
        await this.printLogs(true)
        this.writeLog(
          `openMessageCursorLite failed: sessionId=${sessionId} batchSize=${batchSize} ascending=${ascending ? 1 : 0} begin=${beginTimestamp} end=${endTimestamp} result=${result} cursor=${outCursor[0]}`,
          true
        )
        if (result === -7) {
          return { success: false, error: 'message schema mismatch：当前账号消息表结构与程序要求不一致' }
        }
        return { success: false, error: `创建游标失败: ${result}，请查看日志` }
      }
      return { success: true, cursor: outCursor[0] }
    } catch (e) {
      await this.printLogs(true)
      this.writeLog(`openMessageCursorLite exception: ${String(e)}`, true)
      return { success: false, error: '创建游标异常，请查看日志' }
    }
  }

  async fetchMessageBatch(cursor: number): Promise<{ success: boolean; rows?: any[]; hasMore?: boolean; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outPtr = [null as any]
      const outHasMore = [0]
      const result = this.wcdbFetchMessageBatch(this.handle, cursor, outPtr, outHasMore)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取批次失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析批次失败' }
      const rows = this.parseMessageJson(jsonStr)
      return { success: true, rows, hasMore: outHasMore[0] === 1 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async closeMessageCursor(cursor: number): Promise<{ success: boolean; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const result = this.wcdbCloseMessageCursor(this.handle, cursor)
      if (result !== 0) {
        return { success: false, error: `关闭游标失败: ${result}` }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getLogs(): Promise<{ success: boolean; logs?: string[]; error?: string }> {
    if (!this.lib) return { success: false, error: 'DLL 未加载' }
    if (!this.wcdbGetLogs) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取日志失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析日志失败' }
      return { success: true, logs: JSON.parse(jsonStr) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async execQuery(kind: string, path: string | null, sql: string, params: any[] = []): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    const startedAt = Date.now()
    try {
      if (!this.wcdbExecQuery) return { success: false, error: '接口未就绪' }
      const fallbackFlag = /fallback|diag|diagnostic/i.test(String(sql || ''))
      this.writeLog(`[audit:execQuery] kind=${kind} path=${path || ''} sql_len=${String(sql || '').length} fallback=${fallbackFlag ? 1 : 0}`)

      // 如果提供了参数，使用参数化查询（需要 C++ 层支持）
      // 注意：当前 wcdbExecQuery 可能不支持参数化，这是一个占位符实现
      // TODO: 需要更新 C++ 层的 wcdb_exec_query 以支持参数绑定
      if (params && params.length > 0) {
        console.warn('[wcdbCore] execQuery: 参数化查询暂未在 C++ 层实现，将使用原始 SQL（可能存在注入风险）')
      }

      const normalizedKind = String(kind || '').toLowerCase()
      const isContactQuery = normalizedKind === 'contact' || /\bfrom\s+contact\b/i.test(String(sql))
      let effectivePath = path || ''
      if (normalizedKind === 'contact' && !effectivePath) {
        const resolvedContactDb = this.resolveContactDbPath()
        if (resolvedContactDb) {
          effectivePath = resolvedContactDb
          this.writeLog(`[diag:execQuery] contact path override -> ${effectivePath}`, true)
        } else {
          this.writeLog('[diag:execQuery] contact path override miss: Contact/contact.db not found', true)
        }
      }

      const outPtr = [null as any]
      const result = this.wcdbExecQuery(this.handle, kind, effectivePath, sql, outPtr)
      if (result !== 0 || !outPtr[0]) {
        if (isContactQuery) {
          this.writeLog(`[diag:execQuery] contact query failed code=${result} kind=${kind} path=${effectivePath} sql="${this.formatSqlForLog(sql)}"`, true)
          await this.dumpDbStatus('execQuery-contact-fail')
          await this.printLogs(true)
        }
        return { success: false, error: `执行查询失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析查询结果失败' }
      const rows = JSON.parse(jsonStr)
      this.writeLog(`[audit:execQuery] done kind=${kind} cost_ms=${Date.now() - startedAt} rows=${Array.isArray(rows) ? rows.length : -1}`)
      if (isContactQuery) {
        const count = Array.isArray(rows) ? rows.length : -1
        this.writeLog(`[diag:execQuery] contact query ok rows=${count} kind=${kind} path=${effectivePath} sql="${this.formatSqlForLog(sql)}"`, true)
      }
      return { success: true, rows }
    } catch (e) {
      this.writeLog(`[audit:execQuery] fail kind=${kind} cost_ms=${Date.now() - startedAt} err=${String(e)}`)
      const isContactQuery = String(kind).toLowerCase() === 'contact' || /\bfrom\s+contact\b/i.test(String(sql))
      if (isContactQuery) {
        this.writeLog(`[diag:execQuery] contact query exception kind=${kind} path=${path || ''} sql="${this.formatSqlForLog(sql)}" err=${String(e)}`, true)
        await this.dumpDbStatus('execQuery-contact-exception')
      }
      return { success: false, error: String(e) }
    }
  }

  async getEmoticonCdnUrl(dbPath: string, md5: string): Promise<{ success: boolean; url?: string; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetEmoticonCdnUrl(this.handle, dbPath, md5, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取表情 URL 失败: ${result}` }
      }
      const urlStr = this.decodeJsonPtr(outPtr[0])
      if (urlStr === null) return { success: false, error: '解析表情 URL 失败' }
      return { success: true, url: urlStr || undefined }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getEmoticonCaption(dbPath: string, md5: string): Promise<{ success: boolean; caption?: string; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetEmoticonCaption) {
      return { success: false, error: '接口未就绪: wcdb_get_emoticon_caption' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetEmoticonCaption(this.handle, dbPath || '', md5, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取表情释义失败: ${result}` }
      }
      const captionStr = this.decodeJsonPtr(outPtr[0])
      if (captionStr === null) return { success: false, error: '解析表情释义失败' }
      return { success: true, caption: captionStr || undefined }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getEmoticonCaptionStrict(md5: string): Promise<{ success: boolean; caption?: string; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetEmoticonCaptionStrict) {
      return { success: false, error: '接口未就绪: wcdb_get_emoticon_caption_strict' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetEmoticonCaptionStrict(this.handle, md5, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取表情释义失败(strict): ${result}` }
      }
      const captionStr = this.decodeJsonPtr(outPtr[0])
      if (captionStr === null) return { success: false, error: '解析表情释义失败(strict)' }
      return { success: true, caption: captionStr || undefined }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async listMessageDbs(): Promise<{ success: boolean; data?: string[]; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbListMessageDbs(this.handle, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取消息库列表失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析消息库列表失败' }
      const data = JSON.parse(jsonStr)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async listMediaDbs(): Promise<{ success: boolean; data?: string[]; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbListMediaDbs(this.handle, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取媒体库列表失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析媒体库列表失败' }
      const data = JSON.parse(jsonStr)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  } async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: any; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMessageById(this.handle, sessionId, localId, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `查询消息失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析消息失败' }
      const message = this.parseMessageJson(jsonStr)
      // 处理 wcdb_get_message_by_id 返回空对象的情况
      if (Object.keys(message).length === 0) return { success: false, error: '未找到消息' }
      return { success: true, message }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getVoiceData(sessionId: string, createTime: number, candidates: string[], localId: number = 0, svrId: string | number = 0): Promise<{ success: boolean; hex?: string; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetVoiceData) return { success: false, error: '当前数据服务版本不支持获取语音数据' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetVoiceData(this.handle, sessionId, createTime, localId, BigInt(svrId || 0), JSON.stringify(candidates), outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取语音数据失败: ${result}` }
      }
      const hex = this.decodeJsonPtr(outPtr[0])
      if (hex === null) return { success: false, error: '解析语音数据失败' }
      return { success: true, hex: hex || undefined }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getVoiceDataBatch(
    requests: Array<{ session_id: string; create_time: number; local_id?: number; svr_id?: string | number; candidates?: string[] }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; hex?: string }>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetVoiceDataBatch) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const payload = JSON.stringify(Array.isArray(requests) ? requests : [])
      const result = this.wcdbGetVoiceDataBatch(this.handle, payload, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `批量获取语音数据失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析批量语音数据失败' }
      const rows = JSON.parse(jsonStr)
      const normalized = Array.isArray(rows) ? rows.map((row: any) => ({
        index: Number(row?.index ?? 0),
        hex: row?.hex ? String(row.hex) : undefined
      })) : []
      return { success: true, rows: normalized }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getMediaSchemaSummary(dbPath: string): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetMediaSchemaSummary) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetMediaSchemaSummary(this.handle, dbPath, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取媒体表结构摘要失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析媒体表结构摘要失败' }
      const data = JSON.parse(jsonStr) || {}
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getHeadImageBuffers(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetHeadImageBuffers) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetHeadImageBuffers(this.handle, JSON.stringify(usernames || []), outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取头像二进制失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析头像二进制失败' }
      const map = JSON.parse(jsonStr) || {}
      return { success: true, map }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async resolveImageHardlink(md5: string, accountDir?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbResolveImageHardlink) return { success: false, error: '接口未就绪' }
    try {
      const normalizedMd5 = String(md5 || '').trim().toLowerCase()
      const normalizedAccountDir = String(accountDir || '').trim()
      if (!normalizedMd5) return { success: false, error: 'md5 为空' }
      const cacheKey = this.makeHardlinkCacheKey(normalizedMd5, normalizedAccountDir)
      const cached = this.readHardlinkCache(this.imageHardlinkCache, cacheKey)
      if (cached) return cached

      const outPtr = [null as any]
      const result = this.wcdbResolveImageHardlink(this.handle, normalizedMd5, normalizedAccountDir || null, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `解析图片 hardlink 失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析图片 hardlink 响应失败' }
      const data = JSON.parse(jsonStr) || {}
      const finalResult = { success: true, data }
      this.writeHardlinkCache(this.imageHardlinkCache, cacheKey, finalResult)
      return finalResult
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async resolveVideoHardlinkMd5(md5: string, dbPath?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbResolveVideoHardlinkMd5) return { success: false, error: '接口未就绪' }
    try {
      const normalizedMd5 = String(md5 || '').trim().toLowerCase()
      const normalizedDbPath = String(dbPath || '').trim()
      if (!normalizedMd5) return { success: false, error: 'md5 为空' }
      const cacheKey = this.makeHardlinkCacheKey(normalizedMd5, normalizedDbPath)
      const cached = this.readHardlinkCache(this.videoHardlinkCache, cacheKey)
      if (cached) return cached

      const outPtr = [null as any]
      const result = this.wcdbResolveVideoHardlinkMd5(this.handle, normalizedMd5, normalizedDbPath || null, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `解析视频 hardlink 失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析视频 hardlink 响应失败' }
      const data = JSON.parse(jsonStr) || {}
      const finalResult = { success: true, data }
      this.writeHardlinkCache(this.videoHardlinkCache, cacheKey, finalResult)
      return finalResult
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async resolveImageHardlinkBatch(
    requests: Array<{ md5: string; accountDir?: string }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; md5: string; success: boolean; data?: any; error?: string }>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!Array.isArray(requests)) return { success: false, error: '参数错误: requests 必须是数组' }
    try {
      const normalizedRequests = requests.map((req) => ({
        md5: String(req?.md5 || '').trim().toLowerCase(),
        accountDir: String(req?.accountDir || '').trim()
      }))
      const rows: Array<{ index: number; md5: string; success: boolean; data?: any; error?: string }> = new Array(normalizedRequests.length)
      const unresolved: Array<{ index: number; md5: string; accountDir: string }> = []

      for (let i = 0; i < normalizedRequests.length; i += 1) {
        const req = normalizedRequests[i]
        if (!req.md5) {
          rows[i] = { index: i, md5: '', success: false, error: 'md5 为空' }
          continue
        }
        const cacheKey = this.makeHardlinkCacheKey(req.md5, req.accountDir)
        const cached = this.readHardlinkCache(this.imageHardlinkCache, cacheKey)
        if (cached) {
          rows[i] = {
            index: i,
            md5: req.md5,
            success: cached.success === true,
            data: cached.data,
            error: cached.error
          }
        } else {
          unresolved.push({ index: i, md5: req.md5, accountDir: req.accountDir })
        }
      }

      if (unresolved.length === 0) {
        return { success: true, rows }
      }

      if (this.wcdbResolveImageHardlinkBatch) {
        try {
          const outPtr = [null as any]
          const payload = JSON.stringify(unresolved.map((req) => ({
            md5: req.md5,
            account_dir: req.accountDir || undefined
          })))
          const result = this.wcdbResolveImageHardlinkBatch(this.handle, payload, outPtr)
          if (result === 0 && outPtr[0]) {
            const jsonStr = this.decodeJsonPtr(outPtr[0])
            if (jsonStr) {
              const nativeRows = JSON.parse(jsonStr)
              const mappedRows = Array.isArray(nativeRows) ? nativeRows.map((row: any, index: number) => {
                const rowIndexRaw = Number(row?.index)
                const rowIndex = Number.isFinite(rowIndexRaw) ? Math.floor(rowIndexRaw) : index
                const fallbackReq = rowIndex >= 0 && rowIndex < unresolved.length ? unresolved[rowIndex] : { md5: '', accountDir: '', index: -1 }
                const rowMd5 = String(row?.md5 || fallbackReq.md5 || '').trim().toLowerCase()
                const success = row?.success === true || row?.success === 1 || row?.success === '1'
                const data = row?.data && typeof row.data === 'object' ? row.data : {}
                const error = row?.error ? String(row.error) : undefined
                if (success && rowMd5) {
                  const cacheKey = this.makeHardlinkCacheKey(rowMd5, fallbackReq.accountDir)
                  this.writeHardlinkCache(this.imageHardlinkCache, cacheKey, { success: true, data })
                }
                return {
                  index: rowIndex,
                  md5: rowMd5,
                  success,
                  data,
                  error
                }
              }) : []
              for (const row of mappedRows) {
                const fallbackReq = row.index >= 0 && row.index < unresolved.length ? unresolved[row.index] : null
                if (!fallbackReq) continue
                rows[fallbackReq.index] = {
                  index: fallbackReq.index,
                  md5: row.md5 || fallbackReq.md5,
                  success: row.success,
                  data: row.data,
                  error: row.error
                }
              }
            }
          }
        } catch {
          // 回退到单条循环实现
        }
      }

      for (const req of unresolved) {
        if (rows[req.index]) continue
        const result = await this.resolveImageHardlink(req.md5, req.accountDir)
        rows[req.index] = {
          index: req.index,
          md5: req.md5,
          success: result.success === true,
          data: result.data,
          error: result.error
        }
      }
      return { success: true, rows }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async resolveVideoHardlinkMd5Batch(
    requests: Array<{ md5: string; dbPath?: string }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; md5: string; success: boolean; data?: any; error?: string }>; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!Array.isArray(requests)) return { success: false, error: '参数错误: requests 必须是数组' }
    try {
      const normalizedRequests = requests.map((req) => ({
        md5: String(req?.md5 || '').trim().toLowerCase(),
        dbPath: String(req?.dbPath || '').trim()
      }))
      const rows: Array<{ index: number; md5: string; success: boolean; data?: any; error?: string }> = new Array(normalizedRequests.length)
      const unresolved: Array<{ index: number; md5: string; dbPath: string }> = []

      for (let i = 0; i < normalizedRequests.length; i += 1) {
        const req = normalizedRequests[i]
        if (!req.md5) {
          rows[i] = { index: i, md5: '', success: false, error: 'md5 为空' }
          continue
        }
        const cacheKey = this.makeHardlinkCacheKey(req.md5, req.dbPath)
        const cached = this.readHardlinkCache(this.videoHardlinkCache, cacheKey)
        if (cached) {
          rows[i] = {
            index: i,
            md5: req.md5,
            success: cached.success === true,
            data: cached.data,
            error: cached.error
          }
        } else {
          unresolved.push({ index: i, md5: req.md5, dbPath: req.dbPath })
        }
      }

      if (unresolved.length === 0) {
        return { success: true, rows }
      }

      if (this.wcdbResolveVideoHardlinkMd5Batch) {
        try {
          const outPtr = [null as any]
          const payload = JSON.stringify(unresolved.map((req) => ({
            md5: req.md5,
            db_path: req.dbPath || undefined
          })))
          const result = this.wcdbResolveVideoHardlinkMd5Batch(this.handle, payload, outPtr)
          if (result === 0 && outPtr[0]) {
            const jsonStr = this.decodeJsonPtr(outPtr[0])
            if (jsonStr) {
              const nativeRows = JSON.parse(jsonStr)
              const mappedRows = Array.isArray(nativeRows) ? nativeRows.map((row: any, index: number) => {
                const rowIndexRaw = Number(row?.index)
                const rowIndex = Number.isFinite(rowIndexRaw) ? Math.floor(rowIndexRaw) : index
                const fallbackReq = rowIndex >= 0 && rowIndex < unresolved.length ? unresolved[rowIndex] : { md5: '', dbPath: '', index: -1 }
                const rowMd5 = String(row?.md5 || fallbackReq.md5 || '').trim().toLowerCase()
                const success = row?.success === true || row?.success === 1 || row?.success === '1'
                const data = row?.data && typeof row.data === 'object' ? row.data : {}
                const error = row?.error ? String(row.error) : undefined
                if (success && rowMd5) {
                  const cacheKey = this.makeHardlinkCacheKey(rowMd5, fallbackReq.dbPath)
                  this.writeHardlinkCache(this.videoHardlinkCache, cacheKey, { success: true, data })
                }
                return {
                  index: rowIndex,
                  md5: rowMd5,
                  success,
                  data,
                  error
                }
              }) : []
              for (const row of mappedRows) {
                const fallbackReq = row.index >= 0 && row.index < unresolved.length ? unresolved[row.index] : null
                if (!fallbackReq) continue
                rows[fallbackReq.index] = {
                  index: fallbackReq.index,
                  md5: row.md5 || fallbackReq.md5,
                  success: row.success,
                  data: row.data,
                  error: row.error
                }
              }
            }
          }
        } catch {
          // 回退到单条循环实现
        }
      }

      for (const req of unresolved) {
        if (rows[req.index]) continue
        const result = await this.resolveVideoHardlinkMd5(req.md5, req.dbPath)
        rows[req.index] = {
          index: req.index,
          md5: req.md5,
          success: result.success === true,
          data: result.data,
          error: result.error
        }
      }
      return { success: true, rows }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 数据收集初始化
   */
  async cloudInit(intervalSeconds: number = 600): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      const initOk = await this.initialize()
      if (!initOk) return { success: false, error: 'WCDB init failed' }
    }
    if (!this.wcdbCloudInit) {
      return { success: false, error: 'Cloud init API not supported by DLL' }
    }
    try {
      const result = this.wcdbCloudInit(intervalSeconds)
      if (result !== 0) {
        return { success: false, error: `Cloud init failed: ${result}` }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async cloudReport(statsJson: string): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      const initOk = await this.initialize()
      if (!initOk) return { success: false, error: 'WCDB init failed' }
    }
    if (!this.wcdbCloudReport) {
      return { success: false, error: 'Cloud report API not supported by DLL' }
    }
    try {
      const result = this.wcdbCloudReport(statsJson || '')
      if (result !== 0) {
        return { success: false, error: `Cloud report failed: ${result}` }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  cloudStop(): { success: boolean; error?: string } {
    if (!this.wcdbCloudStop) {
      return { success: false, error: 'Cloud stop API not supported by DLL' }
    }
    try {
      this.wcdbCloudStop()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
  async verifyUser(message: string, hwnd?: string): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      const initOk = await this.initialize()
      if (!initOk) return { success: false, error: 'WCDB 初始化失败' }
    }

    if (!this.wcdbVerifyUser) {
      return { success: false, error: 'Binding not found: VerifyUser' }
    }

    return new Promise((resolve) => {
      try {
        // Allocate buffer for result JSON
        const maxLen = 1024
        const outBuf = Buffer.alloc(maxLen)

        // Call native function
        const hwndVal = hwnd ? BigInt(hwnd) : BigInt(0)
        this.wcdbVerifyUser(hwndVal, message || '', outBuf, maxLen)

        // Parse result
        const jsonStr = this.koffi.decode(outBuf, 'char', -1)
        const result = JSON.parse(jsonStr)
        resolve(result)
      } catch (e) {
        resolve({ success: false, error: String(e) })
      }
    })
  }

  async searchMessages(keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbSearchMessages) return { success: false, error: '当前数据服务版本不支持搜索消息' }
    try {
      const handle = this.handle
      await new Promise(resolve => setImmediate(resolve))
      if (handle === null || this.handle !== handle) return { success: false, error: '连接已断开' }
      const outPtr = [null as any]
      const result = this.wcdbSearchMessages(
        handle,
        sessionId || '',
        keyword,
        limit || 50,
        offset || 0,
        beginTimestamp || 0,
        endTimestamp || 0,
        outPtr
      )
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `搜索消息失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析搜索结果失败' }
      const messages = this.parseMessageJson(jsonStr)
      return { success: true, messages }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetSnsTimeline) return { success: false, error: '当前数据服务版本不支持获取朋友圈' }
    try {
      const outPtr = [null as any]
      const usernamesJson = usernames && usernames.length > 0 ? JSON.stringify(usernames) : ''
      const result = this.wcdbGetSnsTimeline(
        this.handle,
        limit,
        offset,
        usernamesJson,
        keyword || '',
        startTime || 0,
        endTime || 0,
        outPtr
      )
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取朋友圈失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析朋友圈数据失败' }
      const timeline = JSON.parse(jsonStr)
      return { success: true, timeline }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getSnsAnnualStats(beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      if (!this.wcdbGetSnsAnnualStats) {
        return { success: false, error: 'wcdbGetSnsAnnualStats 未找到' }
      }
      await new Promise(resolve => setImmediate(resolve))
      const outPtr = [null as any]
      const result = this.wcdbGetSnsAnnualStats(this.handle, beginTimestamp, endTimestamp, outPtr)
      await new Promise(resolve => setImmediate(resolve))

      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `getSnsAnnualStats failed: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: 'Failed to decode JSON' }
      return { success: true, data: JSON.parse(jsonStr) }
    } catch (e) {
      console.error('getSnsAnnualStats 异常:', e)
      return { success: false, error: String(e) }
    }
  }

  async getSnsUsernames(): Promise<{ success: boolean; usernames?: string[]; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetSnsUsernames) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetSnsUsernames(this.handle, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取朋友圈用户名失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析朋友圈用户名失败' }
      const usernames = JSON.parse(jsonStr)
      return { success: true, usernames: Array.isArray(usernames) ? usernames.map((u: any) => String(u || '').trim()).filter(Boolean) : [] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getSnsExportStats(myWxid?: string): Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbGetSnsExportStats) return { success: false, error: '接口未就绪' }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetSnsExportStats(this.handle, myWxid || null, outPtr)
      if (result !== 0 || !outPtr[0]) return { success: false, error: `获取朋友圈导出统计失败: ${result}` }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析朋友圈导出统计失败' }
      const raw = JSON.parse(jsonStr) || {}
      return {
        success: true,
        data: {
          totalPosts: Number(raw.total_posts || 0),
          totalFriends: Number(raw.total_friends || 0),
          myPosts: raw.my_posts === null || raw.my_posts === undefined ? null : Number(raw.my_posts || 0)
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async installMessageAntiRevokeTrigger(sessionId: string): Promise<{ success: boolean; alreadyInstalled?: boolean; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbInstallMessageAntiRevokeTrigger) return { success: false, error: '当前数据服务版本不支持此功能' }
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return { success: false, error: 'sessionId 不能为空' }
    try {
      const outPtr = [null]
      const status = this.wcdbInstallMessageAntiRevokeTrigger(this.handle, normalizedSessionId, outPtr)
      let msg = ''
      if (outPtr[0]) {
        try { msg = this.koffi.decode(outPtr[0], 'char', -1) } catch { }
        try { this.wcdbFreeString(outPtr[0]) } catch { }
      }
      if (status === 1) {
        return { success: true, alreadyInstalled: true }
      }
      if (status !== 0) {
        return { success: false, error: msg || `DLL error ${status}` }
      }
      return { success: true, alreadyInstalled: false }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async uninstallMessageAntiRevokeTrigger(sessionId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbUninstallMessageAntiRevokeTrigger) return { success: false, error: '当前数据服务版本不支持此功能' }
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return { success: false, error: 'sessionId 不能为空' }
    try {
      const outPtr = [null]
      const status = this.wcdbUninstallMessageAntiRevokeTrigger(this.handle, normalizedSessionId, outPtr)
      let msg = ''
      if (outPtr[0]) {
        try { msg = this.koffi.decode(outPtr[0], 'char', -1) } catch { }
        try { this.wcdbFreeString(outPtr[0]) } catch { }
      }
      if (status !== 0) {
        return { success: false, error: msg || `DLL error ${status}` }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async checkMessageAntiRevokeTrigger(sessionId: string): Promise<{ success: boolean; installed?: boolean; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbCheckMessageAntiRevokeTrigger) return { success: false, error: '当前数据服务版本不支持此功能' }
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return { success: false, error: 'sessionId 不能为空' }
    try {
      const outInstalled = [0]
      const status = this.wcdbCheckMessageAntiRevokeTrigger(this.handle, normalizedSessionId, outInstalled)
      if (status !== 0) {
        return { success: false, error: `DLL error ${status}` }
      }
      return { success: true, installed: outInstalled[0] === 1 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async checkMessageAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>
    error?: string
  }> {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return { success: true, rows: [] }
    }
    const uniqueIds = Array.from(new Set(sessionIds.map((id) => String(id || '').trim()).filter(Boolean)))
    const rows: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }> = []
    for (const sessionId of uniqueIds) {
      const result = await this.checkMessageAntiRevokeTrigger(sessionId)
      rows.push({ sessionId, success: result.success, installed: result.installed, error: result.error })
    }
    return { success: true, rows }
  }

  async installMessageAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>
    error?: string
  }> {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return { success: true, rows: [] }
    }
    const uniqueIds = Array.from(new Set(sessionIds.map((id) => String(id || '').trim()).filter(Boolean)))
    const rows: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }> = []
    for (const sessionId of uniqueIds) {
      const result = await this.installMessageAntiRevokeTrigger(sessionId)
      rows.push({ sessionId, success: result.success, alreadyInstalled: result.alreadyInstalled, error: result.error })
    }
    return { success: true, rows }
  }

  async uninstallMessageAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; error?: string }>
    error?: string
  }> {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return { success: true, rows: [] }
    }
    const uniqueIds = Array.from(new Set(sessionIds.map((id) => String(id || '').trim()).filter(Boolean)))
    const rows: Array<{ sessionId: string; success: boolean; error?: string }> = []
    for (const sessionId of uniqueIds) {
      const result = await this.uninstallMessageAntiRevokeTrigger(sessionId)
      rows.push({ sessionId, success: result.success, error: result.error })
    }
    return { success: true, rows }
  }

  /**
   * 为朋友圈安装删除
   */
  async installSnsBlockDeleteTrigger(): Promise<{ success: boolean; alreadyInstalled?: boolean; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbInstallSnsBlockDeleteTrigger) return { success: false, error: '当前数据服务版本不支持此功能' }
    try {
      const outPtr = [null]
      const status = this.wcdbInstallSnsBlockDeleteTrigger(this.handle, outPtr)
      let msg = ''
      if (outPtr[0]) {
        try { msg = this.koffi.decode(outPtr[0], 'char', -1) } catch { }
        try { this.wcdbFreeString(outPtr[0]) } catch { }
      }
      if (status === 1) {
        //数据服务返回 1 表示已安装
        return { success: true, alreadyInstalled: true }
      }
      if (status !== 0) {
        return { success: false, error: msg || `DLL error ${status}` }
      }
      return { success: true, alreadyInstalled: false }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 关闭朋友圈删除拦截
   */
  async uninstallSnsBlockDeleteTrigger(): Promise<{ success: boolean; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbUninstallSnsBlockDeleteTrigger) return { success: false, error: '当前数据服务版本不支持此功能' }
    try {
      const outPtr = [null]
      const status = this.wcdbUninstallSnsBlockDeleteTrigger(this.handle, outPtr)
      let msg = ''
      if (outPtr[0]) {
        try { msg = this.koffi.decode(outPtr[0], 'char', -1) } catch { }
        try { this.wcdbFreeString(outPtr[0]) } catch { }
      }
      if (status !== 0) {
        return { success: false, error: msg || `DLL error ${status}` }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 查询朋友圈删除拦截是否已安装
   */
  async checkSnsBlockDeleteTrigger(): Promise<{ success: boolean; installed?: boolean; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbCheckSnsBlockDeleteTrigger) return { success: false, error: '当前数据服务版本不支持此功能' }
    try {
      const outInstalled = [0]
      const status = this.wcdbCheckSnsBlockDeleteTrigger(this.handle, outInstalled)
      if (status !== 0) {
        return { success: false, error: `DLL error ${status}` }
      }
      return { success: true, installed: outInstalled[0] === 1 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async deleteSnsPost(postId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ensureReady()) return { success: false, error: 'WCDB 未连接' }
    if (!this.wcdbDeleteSnsPost) return { success: false, error: '当前数据服务版本不支持此功能' }
    try {
      const outPtr = [null]
      const status = this.wcdbDeleteSnsPost(this.handle, postId, outPtr)
      let msg = ''
      if (outPtr[0]) {
        try { msg = this.koffi.decode(outPtr[0], 'char', -1) } catch { }
        try { this.wcdbFreeString(outPtr[0]) } catch { }
      }
      if (status !== 0) {
        return { success: false, error: msg || `DLL error ${status}` }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getDualReportStats(sessionId: string, beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    if (!this.wcdbGetDualReportStats) {
      return { success: false, error: '未支持双人报告统计' }
    }
    try {
      const { begin, end } = this.normalizeRange(beginTimestamp, endTimestamp)
      const outPtr = [null as any]
      const result = this.wcdbGetDualReportStats(this.handle, sessionId, begin, end, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取双人报告统计失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析双人报告统计失败' }
      const data = JSON.parse(jsonStr)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
  /**
   * 修改消息内容
   */
  async updateMessage(sessionId: string, localId: number, createTime: number, newContent: string): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized || !this.wcdbUpdateMessage) return { success: false, error: 'WCDB Not Initialized or Method Missing' }
    if (!this.handle) return { success: false, error: 'Not Connected' }

    return new Promise((resolve) => {
      try {
        const outError = [null as any]
        const result = this.wcdbUpdateMessage(this.handle, sessionId, localId, createTime, newContent, outError)

        if (result !== 0) {
          let errorMsg = 'Unknown Error'
          if (outError[0]) {
            errorMsg = this.decodeJsonPtr(outError[0]) || 'Unknown Error (Decode Failed)'
          }
          resolve({ success: false, error: errorMsg })
          return
        }

        resolve({ success: true })
      } catch (e) {
        resolve({ success: false, error: String(e) })
      }
    })
  }

  /**
   * 删除消息
   */
  async deleteMessage(sessionId: string, localId: number, createTime: number, dbPathHint?: string): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized || !this.wcdbDeleteMessage) return { success: false, error: 'WCDB Not Initialized or Method Missing' }
    if (!this.handle) return { success: false, error: 'Not Connected' }

    return new Promise((resolve) => {
      try {
        const outError = [null as any]
        const result = this.wcdbDeleteMessage(this.handle, sessionId, localId, createTime || 0, dbPathHint || '', outError)

        if (result !== 0) {
          let errorMsg = 'Unknown Error'
          if (outError[0]) {
            errorMsg = this.decodeJsonPtr(outError[0]) || 'Unknown Error (Decode Failed)'
          }
          console.error(`[WcdbCore] deleteMessage fail: code=${result}, error=${errorMsg}`)
          resolve({ success: false, error: errorMsg })
          return
        }

        resolve({ success: true })
      } catch (e) {
        console.error(`[WcdbCore] deleteMessage exception:`, e)
        resolve({ success: false, error: String(e) })
      }
    })
  }
}
