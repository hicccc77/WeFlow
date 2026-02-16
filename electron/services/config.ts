import { join } from 'path'
import { app } from 'electron'
import Store from 'electron-store'

interface ConfigSchema {
  // 数据库相关
  dbPath: string        // 数据库根目录 (xwechat_files)
  decryptKey: string    // 解密密钥
  myWxid: string        // 当前用户 wxid
  onboardingDone: boolean
  imageXorKey: number
  imageAesKey: string
  wxidConfigs: Record<string, { decryptKey?: string; imageXorKey?: number; imageAesKey?: string; updatedAt?: number }>

  // 缓存相关
  cachePath: string
  weixinDllPath: string
  lastOpenedDb: string
  lastSession: string

  // 界面相关
  theme: 'light' | 'dark' | 'system'
  themeId: string
  language: string
  logEnabled: boolean
  llmModelPath: string
  whisperModelName: string
  whisperModelDir: string
  whisperDownloadSource: string
  autoTranscribeVoice: boolean
  transcribeLanguages: string[]
  exportDefaultConcurrency: number
  analyticsExcludedUsernames: string[]

  // 安全相关
  authEnabled: boolean
  authPassword: string // SHA-256 hash
  authUseHello: boolean

  // 更新相关
  ignoredUpdateVersion: string

  // 通知
  notificationEnabled: boolean
  notificationPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  notificationFilterMode: 'all' | 'whitelist' | 'blacklist'
  notificationFilterList: string[]
  wordCloudExcludeWords: string[]
}

export class ConfigService {
  private static instance: ConfigService
  private store!: Store<ConfigSchema>

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
    this.store = new Store<ConfigSchema>({
      name: 'WeFlow-config',
      defaults: {
        dbPath: '',
        decryptKey: '',
        myWxid: '',
        onboardingDone: false,
        imageXorKey: 0,
        imageAesKey: '',
        wxidConfigs: {},
        cachePath: '',
        weixinDllPath: '',
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
        exportDefaultConcurrency: 2,
        analyticsExcludedUsernames: [],

        authEnabled: false,
        authPassword: '',
        authUseHello: false,

        ignoredUpdateVersion: '',
        notificationEnabled: true,
        notificationPosition: 'top-right',
        notificationFilterMode: 'all',
        notificationFilterList: [],
        wordCloudExcludeWords: []
      }
    })
  }

  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    return this.store.get(key)
  }

  set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    this.store.set(key, value)
  }

  getCacheBasePath(): string {
    const configured = this.get('cachePath')
    if (configured && configured.trim().length > 0) {
      return configured
    }
    return join(app.getPath('documents'), 'WeFlow')
  }

  getAll(): ConfigSchema {
    return this.store.store
  }

  clear(): void {
    this.store.clear()
  }
}
