import { join, basename } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'

export interface WxidInfo {
  wxid: string
  modifiedTime: number
}

export class DbPathService {
  /**
   * 自动检测微信数据库根目录
   */
  async autoDetect(): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const possiblePaths: string[] = []
      const home = homedir()

      // 微信4.x 数据目录
      possiblePaths.push(join(home, 'Documents', 'xwechat_files'))
      // 旧版微信数据目录
      possiblePaths.push(join(home, 'Documents', 'WeChat Files'))

      for (const path of possiblePaths) {
        if (existsSync(path)) {
          const rootName = path.split(/[/\\]/).pop()?.toLowerCase()
          if (rootName !== 'xwechat_files' && rootName !== 'wechat files') {
            continue
          }
          
          // 检查是否有有效的账号目录
          const accounts = this.findAccountDirs(path)
          if (accounts.length > 0) {
            return { success: true, path }
          }
        }
      }

      return { success: false, error: '未能自动检测到微信数据库目录' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 查找账号目录（包含 db_storage 或图片目录）
   */
  findAccountDirs(rootPath: string): string[] {
    const accounts: string[] = []
    
    try {
      const entries = readdirSync(rootPath)
      
      for (const entry of entries) {
        const entryPath = join(rootPath, entry)
        let stat: ReturnType<typeof statSync>
        try {
          stat = statSync(entryPath)
        } catch {
          continue
        }
        
        if (stat.isDirectory()) {
          if (!this.isPotentialAccountName(entry)) continue

          // 检查是否有有效账号目录结构
          if (this.isAccountDir(entryPath)) {
            accounts.push(entry)
          }
        }
      }
    } catch {}
    
    return accounts
  }

  private isAccountDir(entryPath: string): boolean {
    return (
      existsSync(join(entryPath, 'db_storage')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image2'))
    )
  }

  private isPotentialAccountName(name: string): boolean {
    const lower = name.toLowerCase()
    if (lower.startsWith('all') || lower.startsWith('applet') || lower.startsWith('backup') || lower.startsWith('wmpf')) {
      return false
    }
    return true
  }

  private getAccountModifiedTime(entryPath: string): number {
    try {
      const accountStat = statSync(entryPath)
      let latest = accountStat.mtimeMs

      const dbPath = join(entryPath, 'db_storage')
      if (existsSync(dbPath)) {
        const dbStat = statSync(dbPath)
        latest = Math.max(latest, dbStat.mtimeMs)
      }

      const imagePath = join(entryPath, 'FileStorage', 'Image')
      if (existsSync(imagePath)) {
        const imageStat = statSync(imagePath)
        latest = Math.max(latest, imageStat.mtimeMs)
      }

      const image2Path = join(entryPath, 'FileStorage', 'Image2')
      if (existsSync(image2Path)) {
        const image2Stat = statSync(image2Path)
        latest = Math.max(latest, image2Stat.mtimeMs)
      }

      return latest
    } catch {
      return 0
    }
  }

  /**
   * 扫描 wxid 列表
   */
  scanWxids(rootPath: string): WxidInfo[] {
    const wxids: WxidInfo[] = []
    
    try {
      if (this.isAccountDir(rootPath)) {
        const wxid = basename(rootPath)
        const modifiedTime = this.getAccountModifiedTime(rootPath)
        return [{ wxid, modifiedTime }]
      }

      const accounts = this.findAccountDirs(rootPath)
      
      for (const account of accounts) {
        const fullPath = join(rootPath, account)
        const modifiedTime = this.getAccountModifiedTime(fullPath)
        wxids.push({ wxid: account, modifiedTime })
      }
    } catch {}
    
    return wxids.sort((a, b) => {
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.wxid.localeCompare(b.wxid)
    })
  }

  /**
   * 获取默认数据库路径
   */
  getDefaultPath(): string {
    const home = homedir()
    return join(home, 'Documents', 'xwechat_files')
  }
}

export const dbPathService = new DbPathService()
