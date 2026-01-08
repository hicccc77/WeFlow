import { join } from 'path'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { app } from 'electron'
import { ConfigService } from './config'

export class WcdbService {
  private configService = new ConfigService()
  private lib: any = null
  private koffi: any = null
  private initialized = false
  private handle: number | null = null  // 改为 number 类型

  // 函数引用
  private wcdbInit: any = null
  private wcdbShutdown: any = null
  private wcdbOpenAccount: any = null
  private wcdbCloseAccount: any = null
  private wcdbFreeString: any = null
  private wcdbGetSessions: any = null
  private wcdbGetMessages: any = null
  private wcdbGetMessageCount: any = null
  private wcdbGetDisplayNames: any = null
  private wcdbGetAvatarUrls: any = null
  private wcdbGetGroupMemberCount: any = null
  private wcdbGetGroupMembers: any = null
  private wcdbGetMessageTables: any = null
  private wcdbGetMessageMeta: any = null
  private wcdbGetContact: any = null
  private wcdbGetMessageTableStats: any = null
  private wcdbOpenMessageCursor: any = null
  private wcdbFetchMessageBatch: any = null
  private wcdbCloseMessageCursor: any = null
  private wcdbGetLogs: any = null

  /**
   * 获取 DLL 路径
   */
  private getDllPath(): string {
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    
    return join(resourcesPath, 'wcdb_api.dll')
  }

  private isLogEnabled(): boolean {
    try {
      return this.configService.get('logEnabled') === true
    } catch {
      return false
    }
  }

  private writeLog(message: string): void {
    if (!this.isLogEnabled()) return
    try {
      const dir = join(app.getPath('userData'), 'logs')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const line = `[${new Date().toISOString()}] ${message}\n`
      appendFileSync(join(dir, 'wcdb.log'), line, { encoding: 'utf8' })
    } catch {}
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
        } catch {}
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
      } catch {}
    }
    return null
  }

  /**
   * 初始化 WCDB
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true

    try {
      this.koffi = require('koffi')
      const dllPath = this.getDllPath()

      if (!existsSync(dllPath)) {
        console.error('WCDB DLL 不存在:', dllPath)
        return false
      }

      this.lib = this.koffi.load(dllPath)

      // 定义类型 - 使用与 C 接口完全匹配的签名
      // wcdb_status wcdb_init()
      this.wcdbInit = this.lib.func('int32 wcdb_init()')
      
      // wcdb_status wcdb_shutdown()
      this.wcdbShutdown = this.lib.func('int32 wcdb_shutdown()')
      
      // wcdb_status wcdb_open_account(const char* session_db_path, const char* hex_key, wcdb_handle* out_handle)
      // wcdb_handle 是 int64_t
      this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)')
      
      // wcdb_status wcdb_close_account(wcdb_handle handle)
      // 注意：虽然 C 接口是 int64，但 koffi 返回的 handle 是 number 类型
      this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)')
      
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

      // wcdb_status wcdb_get_group_members(wcdb_handle handle, const char* chatroom_id, char** out_json)
      this.wcdbGetGroupMembers = this.lib.func('int32 wcdb_get_group_members(int64 handle, const char* chatroomId, _Out_ void** outJson)')

      // wcdb_status wcdb_get_message_tables(wcdb_handle handle, const char* session_id, char** out_json)
      this.wcdbGetMessageTables = this.lib.func('int32 wcdb_get_message_tables(int64 handle, const char* sessionId, _Out_ void** outJson)')

      // wcdb_status wcdb_get_message_meta(wcdb_handle handle, const char* db_path, const char* table_name, int32_t limit, int32_t offset, char** out_json)
      this.wcdbGetMessageMeta = this.lib.func('int32 wcdb_get_message_meta(int64 handle, const char* dbPath, const char* tableName, int32 limit, int32 offset, _Out_ void** outJson)')

      // wcdb_status wcdb_get_contact(wcdb_handle handle, const char* username, char** out_json)
      this.wcdbGetContact = this.lib.func('int32 wcdb_get_contact(int64 handle, const char* username, _Out_ void** outJson)')

      // wcdb_status wcdb_get_message_table_stats(wcdb_handle handle, const char* session_id, char** out_json)
      this.wcdbGetMessageTableStats = this.lib.func('int32 wcdb_get_message_table_stats(int64 handle, const char* sessionId, _Out_ void** outJson)')

      // wcdb_status wcdb_open_message_cursor(wcdb_handle handle, const char* session_id, int32_t batch_size, int32_t ascending, int32_t begin_timestamp, int32_t end_timestamp, wcdb_cursor* out_cursor)
      this.wcdbOpenMessageCursor = this.lib.func('int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)')

      // wcdb_status wcdb_fetch_message_batch(wcdb_handle handle, wcdb_cursor cursor, char** out_json, int32_t* out_has_more)
      this.wcdbFetchMessageBatch = this.lib.func('int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)')

      // wcdb_status wcdb_close_message_cursor(wcdb_handle handle, wcdb_cursor cursor)
      this.wcdbCloseMessageCursor = this.lib.func('int32 wcdb_close_message_cursor(int64 handle, int64 cursor)')
      
      // wcdb_status wcdb_get_logs(char** out_json)
      this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')

      // 初始化
      const initResult = this.wcdbInit()
      if (initResult !== 0) {
        console.error('WCDB 初始化失败:', initResult)
        return false
      }

      this.initialized = true
      return true
    } catch (e) {
      console.error('WCDB 初始化异常:', e)
      return false
    }
  }

  /**
   * 测试数据库连接
   */
  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    try {
      if (!this.initialized) {
        const initOk = await this.initialize()
        if (!initOk) {
          return { success: false, error: 'WCDB 初始化失败' }
        }
      }

      // 构建 db_storage 目录路径
      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      this.writeLog(`testConnection dbPath=${dbPath} wxid=${wxid} dbStorage=${dbStoragePath || 'null'}`)
      
      if (!dbStoragePath || !existsSync(dbStoragePath)) {
        return { success: false, error: `数据库目录不存在: ${dbPath}` }
      }

      // 递归查找 session.db
      const sessionDbPath = this.findSessionDb(dbStoragePath)
      this.writeLog(`testConnection sessionDb=${sessionDbPath || 'null'}`)
      
      if (!sessionDbPath) {
        return { success: false, error: `未找到 session.db 文件` }
      }

      // 分配输出参数内存 - 使用 number 数组
      const handleOut = [0]
      
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)

      if (result !== 0) {
        // 获取 DLL 内部日志
        await this.printLogs()
        let errorMsg = '数据库打开失败'
        if (result === -1) errorMsg = '参数错误'
        else if (result === -2) errorMsg = '密钥错误'
        else if (result === -3) errorMsg = '数据库打开失败'
        this.writeLog(`testConnection openAccount failed code=${result}`)
        return { success: false, error: `${errorMsg} (错误码: ${result})` }
      }

      const handle = handleOut[0]
      if (handle <= 0) {
        return { success: false, error: '无效的数据库句柄' }
      }

      // 连接成功，直接关闭
      // 注意：wcdb_close_account 可能导致崩溃，使用 shutdown 代替
      try {
        // 不调用 closeAccount，直接 shutdown（会释放所有句柄）
        this.wcdbShutdown()
        this.initialized = false  // 标记需要重新初始化
      } catch (closeErr) {
        console.error('关闭数据库时出错:', closeErr)
      }

      return { success: true, sessionCount: 0 }
    } catch (e) {
      console.error('测试连接异常:', e)
      this.writeLog(`testConnection exception: ${String(e)}`)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 打印 DLL 内部日志（仅在出错时调用）
   */
  private async printLogs(): Promise<void> {
    try {
      if (!this.wcdbGetLogs) return
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result === 0 && outPtr[0]) {
        try {
          const jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
          console.error('WCDB 内部日志:', jsonStr)
          this.writeLog(`wcdb_logs: ${jsonStr}`)
          this.wcdbFreeString(outPtr[0])
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      console.error('获取日志失败:', e)
      this.writeLog(`wcdb_logs failed: ${String(e)}`)
    }
  }

  private decodeJsonPtr(outPtr: any): string | null {
    if (!outPtr) return null
    try {
      const jsonStr = this.koffi.decode(outPtr, 'char', -1)
      this.wcdbFreeString(outPtr)
      return jsonStr
    } catch (e) {
      try { this.wcdbFreeString(outPtr) } catch {}
      return null
    }
  }

  private ensureReady(): boolean {
    return this.initialized && this.handle !== null
  }

  isReady(): boolean {
    return this.ensureReady()
  }

  /**
   * 打开数据库
   */
  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    try {
      if (!this.initialized) {
        const initOk = await this.initialize()
        if (!initOk) return false
      }

      if (this.handle !== null) {
        this.close()
        if (!this.initialized) {
          const initOk = await this.initialize()
          if (!initOk) return false
        }
      }

      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      this.writeLog(`open dbPath=${dbPath} wxid=${wxid} dbStorage=${dbStoragePath || 'null'}`)
      
      if (!dbStoragePath || !existsSync(dbStoragePath)) {
        console.error('数据库目录不存在:', dbPath)
        this.writeLog(`open failed: dbStorage not found for ${dbPath}`)
        return false
      }

      const sessionDbPath = this.findSessionDb(dbStoragePath)
      this.writeLog(`open sessionDb=${sessionDbPath || 'null'}`)
      if (!sessionDbPath) {
        console.error('未找到 session.db 文件')
        this.writeLog('open failed: session.db not found')
        return false
      }

      const handleOut = [0]  // 使用 number 而不是 BigInt
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)

      if (result !== 0) {
        console.error('打开数据库失败:', result)
        await this.printLogs()
        this.writeLog(`open failed: openAccount code=${result}`)
        return false
      }

      const handle = handleOut[0]
      if (handle <= 0) {
        return false
      }

      this.handle = handle
      this.initialized = true
      this.writeLog(`open ok handle=${handle}`)
      return true
    } catch (e) {
      console.error('打开数据库异常:', e)
      this.writeLog(`open exception: ${String(e)}`)
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
      this.initialized = false
    }
  }

  /**
   * 关闭服务（与 close 相同）
   */
  shutdown(): void {
    this.close()
  }

  async getSessions(): Promise<{ success: boolean; sessions?: any[]; error?: string }> {
    if (!this.ensureReady()) {
      this.writeLog('getSessions skipped: not connected')
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outPtr = [null as any]
      const result = this.wcdbGetSessions(this.handle, outPtr)
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
      const messages = JSON.parse(jsonStr)
      return { success: true, messages }
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
        return { success: false, error: `获取消息总数失败: ${result}` }
      }
      return { success: true, count: outCount[0] }
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
      const outPtr = [null as any]
      const result = this.wcdbGetDisplayNames(this.handle, JSON.stringify(usernames), outPtr)
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
      const outPtr = [null as any]
      const result = this.wcdbGetAvatarUrls(this.handle, JSON.stringify(usernames), outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取头像失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析头像失败' }
      const map = JSON.parse(jsonStr)
      return { success: true, map }
    } catch (e) {
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
      const outPtr = [null as any]
      const result = this.wcdbGetContact(this.handle, username, outPtr)
      if (result !== 0 || !outPtr[0]) {
        return { success: false, error: `获取联系人失败: ${result}` }
      }
      const jsonStr = this.decodeJsonPtr(outPtr[0])
      if (!jsonStr) return { success: false, error: '解析联系人失败' }
      const contact = JSON.parse(jsonStr)
      return { success: true, contact }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async openMessageCursor(sessionId: string, batchSize: number, ascending: boolean, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; cursor?: number; error?: string }> {
    if (!this.ensureReady()) {
      return { success: false, error: 'WCDB 未连接' }
    }
    try {
      const outCursor = [0]
      const result = this.wcdbOpenMessageCursor(
        this.handle,
        sessionId,
        batchSize,
        ascending ? 1 : 0,
        beginTimestamp,
        endTimestamp,
        outCursor
      )
      if (result !== 0 || outCursor[0] <= 0) {
        return { success: false, error: `创建游标失败: ${result}` }
      }
      return { success: true, cursor: outCursor[0] }
    } catch (e) {
      return { success: false, error: String(e) }
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
      const rows = JSON.parse(jsonStr)
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
}

export const wcdbService = new WcdbService()
