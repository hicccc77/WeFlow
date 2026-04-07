import { join } from 'path'
import { app, safeStorage } from 'electron'
import crypto from 'crypto'
import Store from 'electron-store'

// 加密前缀标记
const SAFE_PREFIX = 'safe:'  // safeStorage 加密（普通模式）
const isSafeStorageAvailable = (): boolean => {
  try {
    return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}
const LOCK_PREFIX = 'lock:'  // 密码派生密钥加密（锁定模式）

interface ConfigSchema {
  // 数据库相关
  dbPath: string
  decryptKey: string
  myWxid: string
  onboardingDone: boolean
  imageXorKey: number
  imageAesKey: string
  wxidConfigs: Record<string, { decryptKey?: string; imageXorKey?: number; imageAesKey?: string; updatedAt?: number }>
  exportPath?: string;
  // 缓存相关
  cachePath: string
  lastOpenedDb: string
  lastSession: string

  // 界面相关
  theme: 'light' | 'dark' | 'system'
  themeId: string
  language: string
  logEnabled: boolean
  launchAtStartup?: boolean
  llmModelPath: string
  whisperModelName: string
  whisperModelDir: string
  whisperDownloadSource: string
  autoTranscribeVoice: boolean
  transcribeLanguages: string[]
  exportDefaultConcurrency: number
  exportDefaultImageDeepSearchOnMiss: boolean
  analyticsExcludedUsernames: string[]

  // 安全相关
  authEnabled: boolean
  authPassword: string      // SHA-256 hash（safeStorage 加密）
  authUseHello: boolean
  authHelloSecret: string   // 原始密码（safeStorage 加密，Hello 解锁时使用）

  // 更新相关
  ignoredUpdateVersion: string
  updateChannel: 'auto' | 'stable' | 'preview' | 'dev'

  // 通知
  notificationEnabled: boolean
  notificationPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center'
  notificationFilterMode: 'all' | 'whitelist' | 'blacklist'
  notificationFilterList: string[]
  messagePushEnabled: boolean
  httpApiEnabled: boolean
  httpApiPort: number
  httpApiHost: string
  httpApiToken: string
  windowCloseBehavior: 'ask' | 'tray' | 'quit'
  quoteLayout: 'quote-top' | 'quote-bottom'
  wordCloudExcludeWords: string[]
  exportWriteLayout: 'A' | 'B' | 'C'

  // AI 见解
  aiInsightEnabled: boolean
  aiInsightApiBaseUrl: string
  aiInsightApiKey: string
  aiInsightApiModel: string
  aiInsightSilenceDays: number
  aiInsightAllowContext: boolean
  aiInsightWhitelistEnabled: boolean
  aiInsightWhitelist: string[]
  /** 活跃分析冷却时间（分钟），0 表示无冷却 */
  aiInsightCooldownMinutes: number
  /** 沉默联系人扫描间隔（小时） */
  aiInsightScanIntervalHours: number
  /** 发送上下文时的最大消息条数 */
  aiInsightContextCount: number
  /** 自定义 system prompt，空字符串表示使用内置默认值 */
  aiInsightSystemPrompt: string
  /** 是否启用 Telegram 推送 */
  aiInsightTelegramEnabled: boolean
  /** Telegram Bot Token */
  aiInsightTelegramToken: string
  /** Telegram 接收 Chat ID，逗号分隔，支持多个 */
  aiInsightTelegramChatIds: string
}

// 需要 safeStorage 加密的字段（普通模式）
const ENCRYPTED_STRING_KEYS: Set<string> = new Set(['decryptKey', 'imageAesKey', 'authPassword', 'httpApiToken', 'aiInsightApiKey'])
const ENCRYPTED_BOOL_KEYS: Set<string> = new Set(['authEnabled', 'authUseHello'])
const ENCRYPTED_NUMBER_KEYS: Set<string> = new Set(['imageXorKey'])

// 需要与密码绑定的敏感密钥字段（锁定模式时用 lock: 加密）
const LOCKABLE_STRING_KEYS: Set<string> = new Set(['decryptKey', 'imageAesKey'])
const LOCKABLE_NUMBER_KEYS: Set<string> = new Set(['imageXorKey'])

export class ConfigService {
  private static instance: ConfigService
  private store!: Store<ConfigSchema>

  // 锁定模式运行时状态
  private unlockedKeys: Map<string, any> = new Map()
  private unlockPassword: string | null = null

  static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService()
    }
    return ConfigService.instance
  }

  constructor() {
    if (ConfigService.instance) {
      return ConfigService.instance
    }
    ConfigService.instance = this
    const defaults: ConfigSchema = {
      dbPath: '',
      decryptKey: '',
      myWxid: '',
      onboardingDone: false,
      imageXorKey: 0,
      imageAesKey: '',
      wxidConfigs: {},
      cachePath: '',
      lastOpenedDb: '',
      lastSession: '',
      theme: 'system',
      themeId: 'cloud-dancer',
      language: 'zh-CN',
      logEnabled: false,
      llmModelPath: '',
      whisperModelName: 'base',
      whisperModelDir: '',
      whisperDownloadSource: 'tsinghua',
      autoTranscribeVoice: false,
      transcribeLanguages: ['zh'],
      exportDefaultConcurrency: 4,
      exportDefaultImageDeepSearchOnMiss: true,
      analyticsExcludedUsernames: [],
      authEnabled: false,
      authPassword: '',
      authUseHello: false,
      authHelloSecret: '',
      ignoredUpdateVersion: '',
      updateChannel: 'auto',
      notificationEnabled: true,
      notificationPosition: 'top-right',
      notificationFilterMode: 'all',
      notificationFilterList: [],
      httpApiToken: '',
      httpApiEnabled: false,
      httpApiPort: 5031,
      httpApiHost: '127.0.0.1',
      messagePushEnabled: false,
      windowCloseBehavior: 'ask',
      quoteLayout: 'quote-top',
      wordCloudExcludeWords: [],
      exportWriteLayout: 'A',
      aiInsightEnabled: false,
      aiInsightApiBaseUrl: '',
      aiInsightApiKey: '',
      aiInsightApiModel: 'gpt-4o-mini',
      aiInsightSilenceDays: 3,
      aiInsightAllowContext: false,
      aiInsightWhitelistEnabled: false,
      aiInsightWhitelist: [],
      aiInsightCooldownMinutes: 120,
      aiInsightScanIntervalHours: 4,
      aiInsightContextCount: 40,
      aiInsightSystemPrompt: '',
      aiInsightTelegramEnabled: false,
      aiInsightTelegramToken: '',
      aiInsightTelegramChatIds: ''
    }

    const storeOptions: any = {
      name: 'WeFlow-config',
      defaults,
      projectName: String(process.env.WEFLOW_PROJECT_NAME || 'WeFlow').trim() || 'WeFlow'
    }
    const runningInWorker = process.env.WEFLOW_WORKER === '1'
    if (runningInWorker) {
      const cwd = String(process.env.WEFLOW_CONFIG_CWD || process.env.WEFLOW_USER_DATA_PATH || '').trim()
      if (cwd) {
        storeOptions.cwd = cwd
      }
    }

    try {
      this.store = new Store<ConfigSchema>(storeOptions)
    } catch (error) {
      const message = String((error as Error)?.message || error || '')
      if (message.includes('projectName')) {
        const fallbackOptions = {
          ...storeOptions,
          projectName: 'WeFlow',
          cwd: storeOptions.cwd || process.env.WEFLOW_CONFIG_CWD || process.env.WEFLOW_USER_DATA_PATH || process.cwd()
        }
        this.store = new Store<ConfigSchema>(fallbackOptions)
      } else {
        throw error
      }
    }
    this.migrateAuthFields()
  }

  // === 状态查询 ===

  isLockMode(): boolean {
    const raw: any = this.store.get('decryptKey')
    return typeof raw === 'string' && raw.startsWith(LOCK_PREFIX)
  }

  isUnlocked(): boolean {
    return !this.isLockMode() || this.unlockedKeys.size > 0
  }

  // === get / set ===

  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    const raw = this.store.get(key)

    if (ENCRYPTED_BOOL_KEYS.has(key)) {
      const str = typeof raw === 'string' ? raw : ''
      if (!str || !str.startsWith(SAFE_PREFIX)) return raw
      return (this.safeDecrypt(str) === 'true') as ConfigSchema[K]
    }

    if (ENCRYPTED_NUMBER_KEYS.has(key)) {
      const str = typeof raw === 'string' ? raw : ''
      if (!str) return raw
      if (str.startsWith(LOCK_PREFIX)) {
        const cached = this.unlockedKeys.get(key as string)
        return (cached !== undefined ? cached : 0) as ConfigSchema[K]
      }
      if (!str.startsWith(SAFE_PREFIX)) return raw
      const num = Number(this.safeDecrypt(str))
      return (Number.isFinite(num) ? num : 0) as ConfigSchema[K]
    }

    if (ENCRYPTED_STRING_KEYS.has(key) && typeof raw === 'string') {
      if (key === 'authPassword') return this.safeDecrypt(raw) as ConfigSchema[K]
      if (raw.startsWith(LOCK_PREFIX)) {
        const cached = this.unlockedKeys.get(key as string)
        return (cached !== undefined ? cached : '') as ConfigSchema[K]
      }
      return this.safeDecrypt(raw) as ConfigSchema[K]
    }

    if (key === 'wxidConfigs' && raw && typeof raw === 'object') {
      return this.decryptWxidConfigs(raw as any) as ConfigSchema[K]
    }

    return raw
  }

  set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    let toStore = value
    const inLockMode = this.isLockMode() && this.unlockPassword

    if (ENCRYPTED_BOOL_KEYS.has(key)) {
      toStore = this.safeEncrypt(String(value)) as ConfigSchema[K]
    } else if (ENCRYPTED_NUMBER_KEYS.has(key)) {
      if (inLockMode && LOCKABLE_NUMBER_KEYS.has(key)) {
        toStore = this.lockEncrypt(String(value), this.unlockPassword!) as ConfigSchema[K]
        this.unlockedKeys.set(key as string, value)
      } else {
        toStore = this.safeEncrypt(String(value)) as ConfigSchema[K]
      }
    } else if (ENCRYPTED_STRING_KEYS.has(key) && typeof value === 'string') {
      if (key === 'authPassword') {
        toStore = this.safeEncrypt(value) as ConfigSchema[K]
      } else if (inLockMode && LOCKABLE_STRING_KEYS.has(key)) {
        toStore = this.lockEncrypt(value, this.unlockPassword!) as ConfigSchema[K]
        this.unlockedKeys.set(key as string, value)
      } else {
        toStore = this.safeEncrypt(value) as ConfigSchema[K]
      }
    } else if (key === 'wxidConfigs' && value && typeof value === 'object') {
      if (inLockMode) {
        toStore = this.lockEncryptWxidConfigs(value as any) as ConfigSchema[K]
      } else {
        toStore = this.encryptWxidConfigs(value as any) as ConfigSchema[K]
      }
    }

    this.store.set(key, toStore)
  }

  // === 加密/解密工具 ===

  private safeEncrypt(plaintext: string): string {
    if (!plaintext) return ''
    if (plaintext.startsWith(SAFE_PREFIX)) return plaintext
    if (!isSafeStorageAvailable()) return plaintext
    const encrypted = safeStorage.encryptString(plaintext)
    return SAFE_PREFIX + encrypted.toString('base64')
  }

  private safeDecrypt(stored: string): string {
    if (!stored) return ''
    if (!stored.startsWith(SAFE_PREFIX)) return stored
    if (!isSafeStorageAvailable()) return ''
    try {
      const buf = Buffer.from(stored.slice(SAFE_PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return ''
    }
  }

  private lockEncrypt(plaintext: string, password: string): string {
    if (!plaintext) return ''
    const salt = crypto.randomBytes(16)
    const iv = crypto.randomBytes(12)
    const derivedKey = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    const combined = Buffer.concat([salt, iv, authTag, encrypted])
    return LOCK_PREFIX + combined.toString('base64')
  }

  private lockDecrypt(stored: string, password: string): string | null {
    if (!stored || !stored.startsWith(LOCK_PREFIX)) return null
    try {
      const combined = Buffer.from(stored.slice(LOCK_PREFIX.length), 'base64')
      const salt = combined.subarray(0, 16)
      const iv = combined.subarray(16, 28)
      const authTag = combined.subarray(28, 44)
      const ciphertext = combined.subarray(44)
      const derivedKey = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
      const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv)
      decipher.setAuthTag(authTag)
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return decrypted.toString('utf8')
    } catch {
      return null
    }
  }

  // 通过尝试解密 lock: 字段来验证密码是否正确（当 authPassword 被删除时使用）
  private verifyPasswordByDecrypt(password: string): boolean {
    // 依次尝试解密任意一个 lock: 字段，GCM authTag 会验证密码正确性
    const lockFields = ['decryptKey', 'imageAesKey', 'imageXorKey'] as const
    for (const key of lockFields) {
      const raw: any = this.store.get(key as any)
      if (typeof raw === 'string' && raw.startsWith(LOCK_PREFIX)) {
        const result = this.lockDecrypt(raw, password)
        // lockDecrypt 返回 null 表示解密失败（密码错误），非 null 表示成功
        return result !== null
      }
    }
    return false
  }

  // === wxidConfigs 加密/解密 ===

  private encryptWxidConfigs(configs: ConfigSchema['wxidConfigs']): ConfigSchema['wxidConfigs'] {
    const result: ConfigSchema['wxidConfigs'] = {}
    for (const [wxid, cfg] of Object.entries(configs)) {
      result[wxid] = { ...cfg }
      if (cfg.decryptKey) result[wxid].decryptKey = this.safeEncrypt(cfg.decryptKey)
      if (cfg.imageAesKey) result[wxid].imageAesKey = this.safeEncrypt(cfg.imageAesKey)
      if (cfg.imageXorKey !== undefined) {
        (result[wxid] as any).imageXorKey = this.safeEncrypt(String(cfg.imageXorKey))
      }
    }
    return result
  }

  private decryptLockedWxidConfigs(password: string): void {
    const wxidConfigs = this.store.get('wxidConfigs')
    if (!wxidConfigs || typeof wxidConfigs !== 'object') return
    for (const [wxid, cfg] of Object.entries(wxidConfigs) as [string, any][]) {
      if (cfg.decryptKey && typeof cfg.decryptKey === 'string' && cfg.decryptKey.startsWith(LOCK_PREFIX)) {
        const d = this.lockDecrypt(cfg.decryptKey, password)
        if (d !== null) this.unlockedKeys.set(`wxid:${wxid}:decryptKey`, d)
      }
      if (cfg.imageAesKey && typeof cfg.imageAesKey === 'string' && cfg.imageAesKey.startsWith(LOCK_PREFIX)) {
        const d = this.lockDecrypt(cfg.imageAesKey, password)
        if (d !== null) this.unlockedKeys.set(`wxid:${wxid}:imageAesKey`, d)
      }
      if (cfg.imageXorKey && typeof cfg.imageXorKey === 'string' && cfg.imageXorKey.startsWith(LOCK_PREFIX)) {
        const d = this.lockDecrypt(cfg.imageXorKey, password)
        if (d !== null) this.unlockedKeys.set(`wxid:${wxid}:imageXorKey`, Number(d))
      }
    }
  }

  private decryptWxidConfigs(configs: ConfigSchema['wxidConfigs']): ConfigSchema['wxidConfigs'] {
    const result: ConfigSchema['wxidConfigs'] = {}
    for (const [wxid, cfg] of Object.entries(configs) as [string, any][]) {
      result[wxid] = { ...cfg, updatedAt: cfg.updatedAt }
      // decryptKey
      if (typeof cfg.decryptKey === 'string') {
        if (cfg.decryptKey.startsWith(LOCK_PREFIX)) {
          result[wxid].decryptKey = this.unlockedKeys.get(`wxid:${wxid}:decryptKey`) ?? ''
        } else {
          result[wxid].decryptKey = this.safeDecrypt(cfg.decryptKey)
        }
      }
      // imageAesKey
      if (typeof cfg.imageAesKey === 'string') {
        if (cfg.imageAesKey.startsWith(LOCK_PREFIX)) {
          result[wxid].imageAesKey = this.unlockedKeys.get(`wxid:${wxid}:imageAesKey`) ?? ''
        } else {
          result[wxid].imageAesKey = this.safeDecrypt(cfg.imageAesKey)
        }
      }
      // imageXorKey
      if (typeof cfg.imageXorKey === 'string') {
        if (cfg.imageXorKey.startsWith(LOCK_PREFIX)) {
          result[wxid].imageXorKey = this.unlockedKeys.get(`wxid:${wxid}:imageXorKey`) ?? 0
        } else if (cfg.imageXorKey.startsWith(SAFE_PREFIX)) {
          const num = Number(this.safeDecrypt(cfg.imageXorKey))
          result[wxid].imageXorKey = Number.isFinite(num) ? num : 0
        }
      }
    }
    return result
  }
  private lockEncryptWxidConfigs(configs: ConfigSchema['wxidConfigs']): ConfigSchema['wxidConfigs'] {
    const result: ConfigSchema['wxidConfigs'] = {}
    for (const [wxid, cfg] of Object.entries(configs)) {
      result[wxid] = { ...cfg }
      if (cfg.decryptKey) result[wxid].decryptKey = this.lockEncrypt(cfg.decryptKey, this.unlockPassword!) as any
      if (cfg.imageAesKey) result[wxid].imageAesKey = this.lockEncrypt(cfg.imageAesKey, this.unlockPassword!) as any
      if (cfg.imageXorKey !== undefined) {
        (result[wxid] as any).imageXorKey = this.lockEncrypt(String(cfg.imageXorKey), this.unlockPassword!)
      }
    }
    return result
  }

  // === 业务方法 ===

  enableLock(password: string): { success: boolean; error?: string } {
    try {
      // 先读取当前所有明文密钥
      const decryptKey = this.get('decryptKey')
      const imageAesKey = this.get('imageAesKey')
      const imageXorKey = this.get('imageXorKey')
      const wxidConfigs = this.get('wxidConfigs')

      // 存储密码 hash（safeStorage 加密）
      const passwordHash = crypto.createHash('sha256').update(password).digest('hex')
      this.store.set('authPassword', this.safeEncrypt(passwordHash) as any)
      this.store.set('authEnabled', this.safeEncrypt('true') as any)

      // 设置运行时状态
      this.unlockPassword = password
      this.unlockedKeys.set('decryptKey', decryptKey)
      this.unlockedKeys.set('imageAesKey', imageAesKey)
      this.unlockedKeys.set('imageXorKey', imageXorKey)

      // 用密码派生密钥重新加密所有敏感字段
      if (decryptKey) this.store.set('decryptKey', this.lockEncrypt(String(decryptKey), password) as any)
      if (imageAesKey) this.store.set('imageAesKey', this.lockEncrypt(String(imageAesKey), password) as any)
      if (imageXorKey !== undefined) this.store.set('imageXorKey', this.lockEncrypt(String(imageXorKey), password) as any)

      // 处理 wxidConfigs 中的嵌套密钥
      if (wxidConfigs && Object.keys(wxidConfigs).length > 0) {
        const lockedConfigs = this.lockEncryptWxidConfigs(wxidConfigs)
        this.store.set('wxidConfigs', lockedConfigs)
        for (const [wxid, cfg] of Object.entries(wxidConfigs)) {
          if (cfg.decryptKey) this.unlockedKeys.set(`wxid:${wxid}:decryptKey`, cfg.decryptKey)
          if (cfg.imageAesKey) this.unlockedKeys.set(`wxid:${wxid}:imageAesKey`, cfg.imageAesKey)
          if (cfg.imageXorKey !== undefined) this.unlockedKeys.set(`wxid:${wxid}:imageXorKey`, cfg.imageXorKey)
        }
      }

      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  unlock(password: string): { success: boolean; error?: string } {
    try {
      // 验证密码
      const storedHash = this.safeDecrypt(this.store.get('authPassword') as any)
      const inputHash = crypto.createHash('sha256').update(password).digest('hex')

      if (storedHash && storedHash !== inputHash) {
        // authPassword 存在但密码不匹配
        return { success: false, error: '密码错误' }
      }

      if (!storedHash) {
        // authPassword 被删除/损坏，尝试用密码直接解密 lock: 字段来验证
        const verified = this.verifyPasswordByDecrypt(password)
        if (!verified) {
          return { success: false, error: '密码错误' }
        }
        // 密码正确，自愈 authPassword
        const newHash = crypto.createHash('sha256').update(password).digest('hex')
        this.store.set('authPassword', this.safeEncrypt(newHash) as any)
        this.store.set('authEnabled', this.safeEncrypt('true') as any)
      }

      // 解密所有 lock: 字段到内存缓存
      const rawDecryptKey: any = this.store.get('decryptKey')
      if (typeof rawDecryptKey === 'string' && rawDecryptKey.startsWith(LOCK_PREFIX)) {
        const d = this.lockDecrypt(rawDecryptKey, password)
        if (d !== null) this.unlockedKeys.set('decryptKey', d)
      }

      const rawImageAesKey: any = this.store.get('imageAesKey')
      if (typeof rawImageAesKey === 'string' && rawImageAesKey.startsWith(LOCK_PREFIX)) {
        const d = this.lockDecrypt(rawImageAesKey, password)
        if (d !== null) this.unlockedKeys.set('imageAesKey', d)
      }

      const rawImageXorKey: any = this.store.get('imageXorKey')
      if (typeof rawImageXorKey === 'string' && rawImageXorKey.startsWith(LOCK_PREFIX)) {
        const d = this.lockDecrypt(rawImageXorKey, password)
        if (d !== null) this.unlockedKeys.set('imageXorKey', Number(d))
      }

      // 解密 wxidConfigs 嵌套密钥
      this.decryptLockedWxidConfigs(password)

      // 保留密码供 set() 使用
      this.unlockPassword = password
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  disableLock(password: string): { success: boolean; error?: string } {
    try {
      // 验证密码
      const storedHash = this.safeDecrypt(this.store.get('authPassword') as any)
      const inputHash = crypto.createHash('sha256').update(password).digest('hex')
      if (storedHash !== inputHash) {
        return { success: false, error: '密码错误' }
      }

      // 先解密所有 lock: 字段
      if (this.unlockedKeys.size === 0) {
        this.unlock(password)
      }

      // 将所有密钥转回 safe: 格式
      const decryptKey = this.unlockedKeys.get('decryptKey')
      const imageAesKey = this.unlockedKeys.get('imageAesKey')
      const imageXorKey = this.unlockedKeys.get('imageXorKey')

      if (decryptKey) this.store.set('decryptKey', this.safeEncrypt(String(decryptKey)) as any)
      if (imageAesKey) this.store.set('imageAesKey', this.safeEncrypt(String(imageAesKey)) as any)
      if (imageXorKey !== undefined) this.store.set('imageXorKey', this.safeEncrypt(String(imageXorKey)) as any)

      // 转换 wxidConfigs
      const wxidConfigs = this.get('wxidConfigs')
      if (wxidConfigs && Object.keys(wxidConfigs).length > 0) {
        const safeConfigs = this.encryptWxidConfigs(wxidConfigs)
        this.store.set('wxidConfigs', safeConfigs)
      }

      // 清除 auth 字段
      this.store.set('authEnabled', false as any)
      this.store.set('authPassword', '' as any)
      this.store.set('authUseHello', false as any)
      this.store.set('authHelloSecret', '' as any)

      // 清除运行时状态
      this.unlockedKeys.clear()
      this.unlockPassword = null

      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  changePassword(oldPassword: string, newPassword: string): { success: boolean; error?: string } {
    try {
      // 验证旧密码
      const storedHash = this.safeDecrypt(this.store.get('authPassword') as any)
      const oldHash = crypto.createHash('sha256').update(oldPassword).digest('hex')
      if (storedHash !== oldHash) {
        return { success: false, error: '旧密码错误' }
      }

      // 确保已解锁
      if (this.unlockedKeys.size === 0) {
        this.unlock(oldPassword)
      }

      // 用新密码重新加密所有密钥
      const decryptKey = this.unlockedKeys.get('decryptKey')
      const imageAesKey = this.unlockedKeys.get('imageAesKey')
      const imageXorKey = this.unlockedKeys.get('imageXorKey')

      if (decryptKey) this.store.set('decryptKey', this.lockEncrypt(String(decryptKey), newPassword) as any)
      if (imageAesKey) this.store.set('imageAesKey', this.lockEncrypt(String(imageAesKey), newPassword) as any)
      if (imageXorKey !== undefined) this.store.set('imageXorKey', this.lockEncrypt(String(imageXorKey), newPassword) as any)

      // 重新加密 wxidConfigs
      const wxidConfigs = this.get('wxidConfigs')
      if (wxidConfigs && Object.keys(wxidConfigs).length > 0) {
        this.unlockPassword = newPassword
        const lockedConfigs = this.lockEncryptWxidConfigs(wxidConfigs)
        this.store.set('wxidConfigs', lockedConfigs)
      }

      // 更新密码 hash
      const newHash = crypto.createHash('sha256').update(newPassword).digest('hex')
      this.store.set('authPassword', this.safeEncrypt(newHash) as any)

      // 更新 Hello secret（如果启用了 Hello）
      const useHello = this.get('authUseHello')
      if (useHello) {
        this.store.set('authHelloSecret', this.safeEncrypt(newPassword) as any)
      }

      this.unlockPassword = newPassword
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  // === Hello 相关 ===

  setHelloSecret(password: string): void {
    this.store.set('authHelloSecret', this.safeEncrypt(password) as any)
    this.store.set('authUseHello', this.safeEncrypt('true') as any)
  }

  getHelloSecret(): string {
    const raw: any = this.store.get('authHelloSecret')
    if (!raw || typeof raw !== 'string') return ''
    return this.safeDecrypt(raw)
  }

  clearHelloSecret(): void {
    this.store.set('authHelloSecret', '' as any)
    this.store.set('authUseHello', this.safeEncrypt('false') as any)
  }

  // === 迁移 ===

  private migrateAuthFields(): void {
    // 将旧版明文 auth 字段迁移为 safeStorage 加密格式
    // 如果已经是 safe: 或 lock: 前缀则跳过
    const rawEnabled: any = this.store.get('authEnabled')
    if (typeof rawEnabled === 'boolean') {
      this.store.set('authEnabled', this.safeEncrypt(String(rawEnabled)) as any)
    }

    const rawUseHello: any = this.store.get('authUseHello')
    if (typeof rawUseHello === 'boolean') {
      this.store.set('authUseHello', this.safeEncrypt(String(rawUseHello)) as any)
    }

    const rawPassword: any = this.store.get('authPassword')
    if (typeof rawPassword === 'string' && rawPassword && !rawPassword.startsWith(SAFE_PREFIX)) {
      this.store.set('authPassword', this.safeEncrypt(rawPassword) as any)
    }

    // 迁移敏感密钥字段（明文 → safe:）
    for (const key of LOCKABLE_STRING_KEYS) {
      const raw: any = this.store.get(key as any)
      if (typeof raw === 'string' && raw && !raw.startsWith(SAFE_PREFIX) && !raw.startsWith(LOCK_PREFIX)) {
        this.store.set(key as any, this.safeEncrypt(raw) as any)
      }
    }

    // imageXorKey: 数字 → safe:
    const rawXor: any = this.store.get('imageXorKey')
    if (typeof rawXor === 'number' && rawXor !== 0) {
      this.store.set('imageXorKey', this.safeEncrypt(String(rawXor)) as any)
    }

    // wxidConfigs 中的嵌套密钥
    const wxidConfigs: any = this.store.get('wxidConfigs')
    if (wxidConfigs && typeof wxidConfigs === 'object') {
      let changed = false
      for (const [_wxid, cfg] of Object.entries(wxidConfigs) as [string, any][]) {
        if (cfg.decryptKey && typeof cfg.decryptKey === 'string' && !cfg.decryptKey.startsWith(SAFE_PREFIX) && !cfg.decryptKey.startsWith(LOCK_PREFIX)) {
          cfg.decryptKey = this.safeEncrypt(cfg.decryptKey)
          changed = true
        }
        if (cfg.imageAesKey && typeof cfg.imageAesKey === 'string' && !cfg.imageAesKey.startsWith(SAFE_PREFIX) && !cfg.imageAesKey.startsWith(LOCK_PREFIX)) {
          cfg.imageAesKey = this.safeEncrypt(cfg.imageAesKey)
          changed = true
        }
        if (typeof cfg.imageXorKey === 'number' && cfg.imageXorKey !== 0) {
          cfg.imageXorKey = this.safeEncrypt(String(cfg.imageXorKey))
          changed = true
        }
      }
      if (changed) {
        this.store.set('wxidConfigs', wxidConfigs)
      }
    }
  }

  // === 验证 ===

  verifyAuthEnabled(): boolean {
    // 先检查 authEnabled 字段
    const rawEnabled: any = this.store.get('authEnabled')
    if (typeof rawEnabled === 'string' && rawEnabled.startsWith(SAFE_PREFIX)) {
      if (this.safeDecrypt(rawEnabled) === 'true') return true
    }

    // 即使 authEnabled 被删除/篡改，如果密钥是 lock: 格式，说明曾开启过应用锁
    const rawDecryptKey: any = this.store.get('decryptKey')
    return typeof rawDecryptKey === 'string' && rawDecryptKey.startsWith(LOCK_PREFIX);


  }

  // === 工具方法 ===

  /**
   * 获取当前 wxid 对应的图片密钥，优先从 wxidConfigs 中取，找不到则回退到全局��置
   */
  getImageKeysForCurrentWxid(): { xorKey: unknown; aesKey: string } {
    const wxid = this.get('myWxid')
    if (wxid) {
      const wxidConfigs = this.get('wxidConfigs')
      const cfg = wxidConfigs?.[wxid]
      if (cfg && (cfg.imageXorKey !== undefined || cfg.imageAesKey)) {
        return {
          xorKey: cfg.imageXorKey ?? this.get('imageXorKey'),
          aesKey: cfg.imageAesKey ?? this.get('imageAesKey')
        }
      }
    }
    return {
      xorKey: this.get('imageXorKey'),
      aesKey: this.get('imageAesKey')
    }
  }

  private getUserDataPath(): string {
    const workerUserDataPath = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
    if (workerUserDataPath) {
      return workerUserDataPath
    }
    return app?.getPath?.('userData') || process.cwd()
  }

  getCacheBasePath(): string {
    return join(this.getUserDataPath(), 'cache')
  }

  getAll(): Partial<ConfigSchema> {
    return this.store.store
  }

  clear(): void {
    this.store.clear()
    this.unlockedKeys.clear()
    this.unlockPassword = null
  }
}
