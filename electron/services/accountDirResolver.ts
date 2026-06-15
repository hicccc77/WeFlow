/**
 * 账号目录解析器（Worker 线程 / 主进程通用）
 *
 * 职责：在 dbPath 根目录下，根据传入的 wxid，找出微信"实际写入数据"
 *       的那个账号子目录，例如：
 *         dbPath = <微信数据根目录>
 *         wxid   = customwxid_abcd  或  customwxid
 *       期望返回 <微信数据根目录>/customwxid_abcd（带后缀、有 session.db 的那个）
 *
 * 与 ConfigService.getAccountDir 行为保持一致；二者实现独立是因为本文件
 * 也会在 Worker 线程中被加载，无法依赖 electron-store。
 */
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// 解析结果缓存（进程内，避免重复 IO）。key = `${dbPath}|${cleanedWxid}`
const accountDirCache = new Map<string, string>()

/**
 * 把 wxid 字符串"标准化"为目录前缀。
 *  - wxid_xxx_yyyy           → wxid_xxx     （wxid_ 后只取第一段）
 *  - 自定义微信号_后缀(4 位)  → 自定义微信号  （例如 customwxid_abcd → customwxid）
 *  - 其他形式                  → 原样返回
 *
 * 注意：清洗只是为了得到"前缀"用于扫描匹配，并不代表清洗结果就是真实目录名。
 *       真实目录名仍需在 dbPath 下按"前缀 + 任意后缀"扫描得出。
 */
const cleanAccountDirName = (dirName: string): string => {
  const trimmed = dirName.trim()
  if (!trimmed) return trimmed

  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    if (match) return match[1]
    return trimmed
  }

  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  if (suffixMatch) return suffixMatch[1]

  return trimmed
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 解析账号目录的真实绝对路径。
 *
 * ## 修复 #996（错误码 -3001：未找到数据库目录）
 *
 * ### 旧实现存在的两处严重缺陷
 * 1. **对 wxid_ 开头的目录强制要求"带后缀"**：
 *    未自定义微信号的普通用户，目录就叫 `wxid_X`（无任何后缀），
 *    旧逻辑会因为段数不足而把它过滤掉，导致这类用户根本匹配不到。
 *
 * 2. **对非 wxid_ 开头（自定义微信号）走短路返回，且不校验目录有效性**：
 *    旧实现写法是
 *      ```
 *      if (!lowerWxid.startsWith('wxid_')) {
 *        const direct = join(root, cleanedWxid)
 *        if (existsSync(direct)) return direct  // ← 直接返回，没校验里面有没有 db_storage
 *      }
 *      ```
 *    叠加 `cleanAccountDirName` 会把 `<自定义号>_<4位后缀>` 清洗成
 *    `<自定义号>`，于是无论用户存的是哪个 wxid，都会命中旧的、无后缀的
 *    空目录（它真实存在但里面没有 db_storage），最终触发 -3001。
 *
 * ### 修复后的统一匹配流程
 * 1. 扫描 dbPath 下所有子目录；
 * 2. 同时接受**精确匹配**(`entry == cleanedWxid`) 与
 *    **后缀匹配**(`entry.startsWith(cleanedWxid + '_')`) 两种命中方式；
 * 3. 用 {@link accountDirLooksValid} 过滤掉"看起来根本不像账号目录"的项
 *    （没有 db_storage 也没有 FileStorage/Image[2]）；
 * 4. 在剩余候选中按以下优先级排序，取最优：
 *    - **有 session.db** > 没有：区分"真正写入数据"与"残留空目录"；
 *    - **后缀匹配** > 精确匹配：与微信 4.x 实际写入目录的命名习惯一致；
 *    - **修改时间更新** > 更旧：兜底。
 */
export const resolveAccountDir = (dbPath?: string, wxid?: string): string | null => {
  if (!dbPath || !wxid) return null

  const cleanedWxid = cleanAccountDirName(wxid)
  const normalized = dbPath.replace(/[\\/]+$/, '')
  const cacheKey = `${normalized}|${cleanedWxid.toLowerCase()}`

  // 命中缓存且目标仍存在则直接返回；目标已被删除的过期缓存项会被剔除
  const cached = accountDirCache.get(cacheKey)
  if (cached && existsSync(cached)) return cached
  if (cached && !existsSync(cached)) {
    accountDirCache.delete(cacheKey)
  }

  const lowerWxid = cleanedWxid.toLowerCase()

  try {
    const entries = readdirSync(normalized)
    type Candidate = { entryPath: string; isExact: boolean; hasSession: boolean; mtime: number }
    const candidates: Candidate[] = []

    for (const entry of entries) {
      const entryPath = join(normalized, entry)
      if (!isDirectory(entryPath)) continue

      const lowerEntry = entry.toLowerCase()
      const isExactMatch = lowerEntry === lowerWxid
      const isSuffixMatch = lowerEntry.startsWith(`${lowerWxid}_`)
      // 既不是精确命中、也不是前缀命中 → 与本 wxid 无关，跳过
      if (!isExactMatch && !isSuffixMatch) continue

      // 看起来不像账号目录（连 db_storage 与 FileStorage/Image 都没有）→ 跳过
      // 这一步是修复 #996 的关键：自定义微信号场景下旧的、无后缀空目录
      // 会在这里被过滤掉，避免后续 wcdbCore.open 误判为真实账号目录。
      if (!accountDirLooksValid(entryPath)) continue

      let mtime = 0
      try { mtime = statSync(entryPath).mtimeMs } catch { /* 忽略 stat 异常 */ }
      candidates.push({
        entryPath,
        isExact: isExactMatch,
        hasSession: accountDirHasSessionDb(entryPath),
        mtime,
      })
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        // 1) 优先选有 session.db 的（真实写入数据的目录）
        if (a.hasSession !== b.hasSession) return a.hasSession ? -1 : 1
        // 2) 其次优先选"带后缀"的（更接近微信 4.x 实际写入目录）
        if (a.isExact !== b.isExact) return a.isExact ? 1 : -1
        // 3) 最后按修改时间倒序（最新的优先）
        return b.mtime - a.mtime
      })
      const best = candidates[0].entryPath
      accountDirCache.set(cacheKey, best)
      return best
    }
  } catch { /* 扫描目录失败时直接 fallthrough 返回 null */ }

  return null
}

/**
 * 浅层判定一个目录"看起来像不像账号目录"：
 *   存在 db_storage 子目录，或存在 FileStorage/Image[2] 子目录之一即认为是。
 *
 * 用于在候选阶段剔除"同名但实际无数据"的残留空目录
 *（例如自定义微信号后遗留下来的旧 wxid 主目录）。
 */
const accountDirLooksValid = (entryPath: string): boolean => {
  return (
    existsSync(join(entryPath, 'db_storage')) ||
    existsSync(join(entryPath, 'FileStorage', 'Image')) ||
    existsSync(join(entryPath, 'FileStorage', 'Image2'))
  )
}

/**
 * 检测账号目录下是否存在 session.db。
 *
 * 是排序优先级里"区分真实写入数据 vs 仅有空 db_storage 骨架"的关键判据，
 * 同时兼容微信 4.x 两种已知布局：
 *   - db_storage/session/session.db （新版本嵌套布局）
 *   - db_storage/session.db          （部分版本扁平布局）
 */
const accountDirHasSessionDb = (entryPath: string): boolean => {
  const candidates = [
    join(entryPath, 'db_storage', 'session', 'session.db'),
    join(entryPath, 'db_storage', 'session.db'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return true
  }
  return false
}
