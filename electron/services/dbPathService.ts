import { join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'

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
   * 查找账号目录（包含 db_storage 的目录）
   */
  findAccountDirs(rootPath: string): string[] {
    const accounts: string[] = []
    
    try {
      const entries = readdirSync(rootPath)
      
      for (const entry of entries) {
        const entryPath = join(rootPath, entry)
        const stat = statSync(entryPath)
        
        if (stat.isDirectory()) {
          // 检查是否有 db_storage 子目录
          const dbStoragePath = join(entryPath, 'db_storage')
          if (existsSync(dbStoragePath)) {
            accounts.push(entry)
          }
        }
      }
    } catch {}
    
    return accounts
  }

  /**
   * 扫描 wxid 列表
   */
  scanWxids(rootPath: string): string[] {
    const wxids: string[] = []
    
    try {
      const accounts = this.findAccountDirs(rootPath)
      
      for (const account of accounts) {
        // wxid 格式: wxid_xxxxx 或纯数字
        if (account.startsWith('wxid_') || /^\d+$/.test(account)) {
          wxids.push(account)
        }
      }
    } catch {}
    
    return wxids
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
