import { join, basename } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { createDecipheriv } from 'crypto'
import { expandHomePath } from '../utils/pathUtils'

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
   * 查找 dbPath 根目录下所有"看起来像账号目录"的子目录名。
   *
   * ## 修复 #996（错误码 -3001：未找到数据库目录）
   *
   * ### 旧实现的过滤逻辑及缺陷
   * 旧实现对名字以 `wxid_` 开头的目录额外加了一道判断：
   *   "段数（按下划线切分）必须 ≥ 3，否则跳过"
   * 也就是 `wxid_X_<suffix>` 才算合法、`wxid_X` 一律忽略。
   *
   * 这种粗暴过滤会**误伤未自定义微信号的普通用户**——他们的真实账号目录
   * 就叫 `wxid_X`（没有任何数字后缀），结果在欢迎页扫描时压根看不到自己。
   *
   * ### 修复策略
   * 1. **不再依据"段数"过滤**：先按是否真的是账号目录（含 db_storage 或
   *    FileStorage/Image[2]）一视同仁地收集所有候选；
   * 2. **用 {@link dedupeAccountDirs} 做更精准的去重**：仅当 `wxid_X` 和
   *    `wxid_X_<suffix>` 同时存在时（这是自定义微信号后微信遗留旧空目录
   *    的典型场景），才二选一保留"更像微信实际在用"的那个，避免下拉框里
   *    出现两个看起来一样但只有一个能用的混乱选项。
   */
  findAccountDirs(rootPath: string): string[] {
    const resolvedRootPath = expandHomePath(rootPath)
    const accounts: string[] = []

    try {
      const entries = readdirSync(resolvedRootPath)

      for (const entry of entries) {
        const entryPath = join(resolvedRootPath, entry)
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

    return this.dedupeAccountDirs(resolvedRootPath, accounts)
  }

  /**
   * 账号目录去重：仅当存在"前缀-后缀变体对"时（即同时出现 `wxid_X` 与
   * `wxid_X_<suffix>`），才二选一保留"微信实际在用"的那个目录。
   *
   * - 仅有一个候选目录时，原样返回，不做任何处理；
   * - 没有匹配到变体对的目录也都保留（互不相关的多账号场景）；
   * - 真正二选一时由 {@link shouldPreferSuffixedDir} 决定胜负。
   */
  private dedupeAccountDirs(rootPath: string, names: string[]): string[] {
    if (names.length <= 1) return names.slice()

    const lowered = names.map(n => n.toLowerCase())
    const toSkip = new Set<string>()

    // O(n^2) 双层循环找出所有"前缀-后缀变体对"。账号数极少，性能可忽略。
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue
        // 判定 names[j] 是 names[i] 的"带后缀变体"：以 `<i>_` 开头
        if (lowered[j].startsWith(lowered[i] + '_')) {
          const baseName = names[i]
          const suffixedName = names[j]
          if (this.shouldPreferSuffixedDir(rootPath, baseName, suffixedName)) {
            toSkip.add(baseName)        // 留 suffixedName，去掉无后缀的旧目录
          } else {
            toSkip.add(suffixedName)    // 反之亦然
          }
        }
      }
    }

    return names.filter(n => !toSkip.has(n))
  }

  /**
   * 在"无后缀目录"与"带后缀目录"之间二选一时，判定后者是否应该胜出。
   *
   * 优先级（从高到低）：
   *   1) 谁含有 session.db 谁优先 —— 这是"数据真实写入"最强的信号；
   *   2) 都含或都不含 session.db 时，比较修改时间，更新的优先；
   *   3) 兜底返回 true，即默认保留带后缀的目录（与微信 4.x 自定义微信号
   *      后真实目录命名一致）。
   */
  private shouldPreferSuffixedDir(rootPath: string, baseName: string, suffixedName: string): boolean {
    const basePath = join(rootPath, baseName)
    const suffixedPath = join(rootPath, suffixedName)

    const baseHasSession = this.hasSessionDb(basePath)
    const suffixedHasSession = this.hasSessionDb(suffixedPath)
    if (baseHasSession !== suffixedHasSession) {
      return suffixedHasSession
    }

    const baseTime = this.getAccountModifiedTime(basePath)
    const suffixedTime = this.getAccountModifiedTime(suffixedPath)
    if (baseTime !== suffixedTime) {
      return suffixedTime >= baseTime
    }

    return true
  }

  /**
   * 浅层检测账号目录下是否存在 session.db（"数据是否真实写入"的判据）。
   *
   * 仅检测两条已知路径，不做深度递归，避免在大目录上拖慢扫描：
   *   - db_storage/session/session.db （新版本嵌套布局）
   *   - db_storage/session.db          （部分版本扁平布局）
   */
  private hasSessionDb(accountDir: string): boolean {
    const candidates = [
      join(accountDir, 'db_storage', 'session', 'session.db'),
      join(accountDir, 'db_storage', 'session.db'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return true
    }
    return false
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
   * 扫描 dbPath 下"目录名包含下划线"的文件夹作为 wxid 候选。
   * 与 {@link findAccountDirs} 的区别：本方法不要求目录里真的有 db_storage/
   * FileStorage，仅按命名特征判断，结果会暴露给"手动选择 wxid"的弹窗使用。
   *
   * ## 修复 #996（错误码 -3001：未找到数据库目录）
   *
   * 旧实现对 `wxid_` 开头的目录额外要求"段数 ≥ 3"才放行，会误伤未自定义
   * 微信号的普通用户（他们的真实目录就叫 `wxid_X`）。现在改为不再依据段数
   * 过滤，并在末尾通过 {@link dedupeAccountDirs} 处理 `wxid_X` 与
   * `wxid_X_<suffix>` 同时存在的去重场景。
   *
   * 排除规则保留：
   *   - 微信本身的非账号目录（如 `all_users`）；
   *   - 不含下划线的文件夹（不可能是 wxid）。
   */
  scanWxidCandidates(rootPath: string): WxidInfo[] {
    const resolvedRootPath = expandHomePath(rootPath)
    const wxids: WxidInfo[] = []

    try {
      if (existsSync(resolvedRootPath)) {
        const entries = readdirSync(resolvedRootPath)
        for (const entry of entries) {
          const entryPath = join(resolvedRootPath, entry)
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
        const rootName = basename(resolvedRootPath)
        if (rootName.includes('_') && rootName.toLowerCase() !== 'all_users') {
          const rootStat = statSync(resolvedRootPath)
          wxids.push({ wxid: rootName, modifiedTime: rootStat.mtimeMs })
        }
      }
    } catch { }

    // 修复 #996：对扫描到的 wxid 候选做去重，避免同时显示 wxid_X 与 wxid_X_<suffix>。
    const dedupedNames = new Set(
      this.dedupeAccountDirs(resolvedRootPath, wxids.map(w => w.wxid))
    )
    const deduped = wxids.filter(w => dedupedNames.has(w.wxid))

    const sorted = deduped.sort((a, b) => {
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.wxid.localeCompare(b.wxid)
    });

    const globalInfo = this.parseGlobalConfig(resolvedRootPath);
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
    const resolvedRootPath = expandHomePath(rootPath)
    const wxids: WxidInfo[] = []

    try {
      if (this.isAccountDir(resolvedRootPath)) {
        const wxid = basename(resolvedRootPath)
        const modifiedTime = this.getAccountModifiedTime(resolvedRootPath)
        return [{ wxid, modifiedTime }]
      }

      const accounts = this.findAccountDirs(resolvedRootPath)

      for (const account of accounts) {
        const fullPath = join(resolvedRootPath, account)
        const modifiedTime = this.getAccountModifiedTime(fullPath)
        wxids.push({ wxid: account, modifiedTime })
      }
    } catch { }

    const sorted = wxids.sort((a, b) => {
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.wxid.localeCompare(b.wxid)
    });

    const globalInfo = this.parseGlobalConfig(resolvedRootPath);
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
