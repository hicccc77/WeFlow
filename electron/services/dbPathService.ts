import { join, basename } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { createDecipheriv } from 'crypto'

export interface WxidInfo {
  wxid: string
  modifiedTime: number
  nickname?: string
  avatarUrl?: string
}

export class DbPathService {
  private readVarint(buf: Buffer, offset: number): { value: number, length: number } {
    let value = 0;
    let length = 0;
    let shift = 0;
    while (offset < buf.length && shift < 32) {
      const b = buf[offset++];
      value |= (b & 0x7f) << shift;
      length++;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return { value, length };
  }

  private extractMmkvString(buf: Buffer, keyName: string): string {
    const keyBuf = Buffer.from(keyName, 'utf8');
    const idx = buf.indexOf(keyBuf);
    if (idx === -1) return '';

    try {
      let offset = idx + keyBuf.length;
      const v1 = this.readVarint(buf, offset);
      offset += v1.length;
      const v2 = this.readVarint(buf, offset);
      offset += v2.length;

      // 合理性检查
      if (v2.value > 0 && v2.value <= 10000 && offset + v2.value <= buf.length) {
        return buf.toString('utf8', offset, offset + v2.value);
      }
    } catch { }
    return '';
  }

  private parseGlobalConfig(rootPath: string): { wxid: string, nickname: string, avatarUrl: string } | null {
    try {
      const configPath = join(rootPath, 'all_users', 'config', 'global_config');
      if (!existsSync(configPath)) return null;

      const fullData = readFileSync(configPath);
      if (fullData.length <= 4) return null;
      const encryptedData = fullData.subarray(4);

      const key = Buffer.alloc(16, 0);
      Buffer.from('xwechat_crypt_key').copy(key);   // 直接硬编码，iv更是不重要
      const iv = Buffer.alloc(16, 0);

      const decipher = createDecipheriv('aes-128-cfb', key, iv);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

      const wxid = this.extractMmkvString(decrypted, 'mmkv_key_user_name');
      const nickname = this.extractMmkvString(decrypted, 'mmkv_key_nick_name');
      let avatarUrl = this.extractMmkvString(decrypted, 'mmkv_key_head_img_url');

      if (!avatarUrl && decrypted.includes('http')) {
        const httpIdx = decrypted.indexOf('http');
        const nullIdx = decrypted.indexOf(0x00, httpIdx);
        if (nullIdx !== -1) {
          avatarUrl = decrypted.toString('utf8', httpIdx, nullIdx);
        }
      }

      if (wxid || nickname) {
        return { wxid, nickname, avatarUrl };
      }
      return null;
    } catch (e) {
      console.error('解析 global_config 失败:', e);
      return null;
    }
  }


  /**
   * 自动检测微信数据库根目录
   */
  async autoDetect(): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const possiblePaths: string[] = []
      const home = homedir()

      if (process.platform === 'darwin') {
        // macOS 微信 4.0.5+ 新路径（优先检测）
        const appSupportBase = join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat')
        if (existsSync(appSupportBase)) {
          try {
            const entries = readdirSync(appSupportBase)
            for (const entry of entries) {
              // 匹配形如 2.0b4.0.9 的版本目录
              if (/^\d+\.\d+b\d+\.\d+/.test(entry) || /^\d+\.\d+\.\d+/.test(entry)) {
                possiblePaths.push(join(appSupportBase, entry))
              }
            }
          } catch { }
        }
        // macOS 旧路径兜底
        possiblePaths.push(join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files'))
      } else {
        // Windows 微信4.x 数据目录
        possiblePaths.push(join(home, 'Documents', 'xwechat_files'))
      }

      for (const path of possiblePaths) {
        if (!existsSync(path)) continue

        // 检查是否有有效的账号目录，或本身就是账号目录
        const accounts = this.findAccountDirs(path)
        if (accounts.length > 0) {
          return { success: true, path }
        }

        // 如果该目录本身就是账号目录（直接包含 db_storage 等）
        if (this.isAccountDir(path)) {
          return { success: true, path }
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
    } catch { }

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
   * 扫描目录名候选（仅包含下划线的文件夹，排除 all_users）
   */
  scanWxidCandidates(rootPath: string): WxidInfo[] {
    const wxids: WxidInfo[] = []

    try {
      if (existsSync(rootPath)) {
        const entries = readdirSync(rootPath)
        for (const entry of entries) {
          const entryPath = join(rootPath, entry)
          let stat: ReturnType<typeof statSync>
          try { stat = statSync(entryPath) } catch { continue }
          if (!stat.isDirectory()) continue
          const lower = entry.toLowerCase()
          if (lower === 'all_users') continue
          if (!entry.includes('_')) continue
          wxids.push({ wxid: entry, modifiedTime: stat.mtimeMs })
        }
      }


      if (wxids.length === 0) {
        const rootName = basename(rootPath)
        if (rootName.includes('_') && rootName.toLowerCase() !== 'all_users') {
          const rootStat = statSync(rootPath)
          wxids.push({ wxid: rootName, modifiedTime: rootStat.mtimeMs })
        }
      }
    } catch { }

    const sorted = wxids.sort((a, b) => {
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.wxid.localeCompare(b.wxid)
    });

    const globalInfo = this.parseGlobalConfig(rootPath);
    if (globalInfo) {
      for (const w of sorted) {
        if (w.wxid.startsWith(globalInfo.wxid) || sorted.length === 1) {
          w.nickname = globalInfo.nickname;
          w.avatarUrl = globalInfo.avatarUrl;
        }
      }
    }

    return sorted;
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
    } catch { }

    const sorted = wxids.sort((a, b) => {
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.wxid.localeCompare(b.wxid)
    });

    const globalInfo = this.parseGlobalConfig(rootPath);
    if (globalInfo) {
      for (const w of sorted) {
        if (w.wxid.startsWith(globalInfo.wxid) || sorted.length === 1) {
          w.nickname = globalInfo.nickname;
          w.avatarUrl = globalInfo.avatarUrl;
        }
      }
    }
    return sorted;
  }

  /**
   * 获取默认数据库路径
   */
  getDefaultPath(): string {
    const home = homedir()
    if (process.platform === 'darwin') {
      // 优先返回 4.0.5+ 新路径
      const appSupportBase = join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat')
      if (existsSync(appSupportBase)) {
        try {
          const entries = readdirSync(appSupportBase)
          for (const entry of entries) {
            if (/^\d+\.\d+b\d+\.\d+/.test(entry) || /^\d+\.\d+\.\d+/.test(entry)) {
              const candidate = join(appSupportBase, entry)
              if (existsSync(candidate)) return candidate
            }
          }
        } catch { }
      }
      // 旧版本路径兜底
      return join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files')
    }
    return join(home, 'Documents', 'xwechat_files')
  }
}

export const dbPathService = new DbPathService()
