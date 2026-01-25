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
}

export class ConfigService {
  private store: Store<ConfigSchema>

  constructor() {
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
        transcribeLanguages: ['zh']
      }
    })
  }

  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    return this.store.get(key)
  }

  set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    this.store.set(key, value)
  }

  getAll(): ConfigSchema {
    return this.store.store
  }

  clear(): void {
    this.store.clear()
  }
}
