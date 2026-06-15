import { app } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { execFile, exec, spawn } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import { createRequire } from 'module';
const require = createRequire(__filename);

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }

export class KeyServiceLinux {
  private sudo: any

  constructor() {
    try {
      this.sudo = require('@vscode/sudo-prompt');
    } catch (e) {
      console.error('Failed to load @vscode/sudo-prompt', e);
    }
  }

  private getHelperPath(): string {
    const isPackaged = app.isPackaged
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const candidates: string[] = []
    if (process.env.WX_KEY_HELPER_PATH) candidates.push(process.env.WX_KEY_HELPER_PATH)
    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'resources', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'xkey_helper_linux'))
    } else {
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), 'resources', 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', archDir, 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', 'x64', 'xkey_helper_linux'))
      candidates.push(join(process.cwd(), 'resources', 'key', 'linux', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), '..', 'Xkey', 'build', 'xkey_helper_linux'))
    }
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    throw new Error('找不到 xkey_helper_linux，请检查路径')
  }

  public async autoGetDbKey(
      timeoutMs = 60_000,
      onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    try {
      // 1. 构造一个包含常用系统命令路径的环境变量，防止打包后找不到命令
      const envWithPath = {
        ...process.env,
        PATH: `${process.env.PATH || ''}:/bin:/usr/bin:/sbin:/usr/sbin:/usr/local/bin`
      };

      onStatus?.('正在尝试结束当前微信进程...', 0)
      console.log('[Debug] 开始执行进程清理逻辑...');

      try {
        const { stdout, stderr } = await execAsync('killall -9 wechat wechat-bin xwechat', { env: envWithPath });
        console.log(`[Debug] killall 成功退出. stdout: ${stdout}, stderr: ${stderr}`);
      } catch (err: any) {
        // 命令如果没找到进程通常会返回 code 1，这也是正常的，但我们需要记录下来
        console.log(`[Debug] killall 报错或未找到进程: ${err.message}`);

        // Fallback: 尝试使用 pkill 兜底
        try {
          console.log('[Debug] 尝试使用备用命令 pkill...');
          await execAsync('pkill -9 -x "wechat|wechat-bin|xwechat"', { env: envWithPath });
          console.log('[Debug] pkill 执行完成');
        } catch (e: any) {
          console.log(`[Debug] pkill 报错或未找到进程: ${e.message}`);
        }
      }

      // 稍微等待进程完全退出
      await new Promise(r => setTimeout(r, 1000))

      onStatus?.('正在尝试拉起微信...', 0)

      const cleanEnv = { ...process.env };
      delete cleanEnv.ELECTRON_RUN_AS_NODE;
      delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE;
      delete cleanEnv.APPDIR;
      delete cleanEnv.APPIMAGE;

      const wechatBins = [
        'wechat',
        'wechat-bin',
        'xwechat',
        '/opt/wechat/wechat',
        '/usr/bin/wechat',
        '/usr/local/bin/wechat',
        '/usr/bin/wechat',
        '/opt/apps/com.tencent.wechat/files/wechat',
        '/usr/bin/wechat-bin',
        '/usr/local/bin/wechat-bin',
        'com.tencent.wechat'
      ]

      for (const binName of wechatBins) {
        try {
          const child = spawn(binName, [], {
            detached: true,
            stdio: 'ignore',
            env: cleanEnv
          });

          child.on('error', (err) => {
            console.log(`[Debug] 拉起 ${binName} 失败:`, err.message);
          });

          child.unref();
          console.log(`[Debug] 尝试拉起 ${binName} 完毕`);
        } catch (e: any) {
          console.log(`[Debug] 尝试拉起 ${binName} 发生异常:`, e.message);
        }
      }

      onStatus?.('等待微信进程出现...', 0)
      let pid = 0
      for (let i = 0; i < 15; i++) { // 最多等 15 秒
        await new Promise(r => setTimeout(r, 1000))

        try {
          const { stdout } = await execAsync('pidof wechat wechat-bin xwechat', { env: envWithPath });
          const pids = stdout.trim().split(/\s+/).filter(p => p);
          if (pids.length > 0) {
            pid = parseInt(pids[0], 10);
            console.log(`[Debug] 第 ${i + 1} 秒，通过 pidof 成功获取 PID: ${pid}`);
            break;
          }
        } catch (err: any) {
          console.log(`[Debug] 第 ${i + 1} 秒，pidof 失败: ${err.message.split('\n')[0]}`);

          // Fallback: 使用 pgrep 兜底
          try {
            const { stdout: pgrepOut } = await execAsync('pgrep -x "wechat|wechat-bin|xwechat"', { env: envWithPath });
            const pids = pgrepOut.trim().split(/\s+/).filter(p => p);
            if (pids.length > 0) {
              pid = parseInt(pids[0], 10);
              console.log(`[Debug] 第 ${i + 1} 秒，通过 pgrep 成功获取 PID: ${pid}`);
              break;
            }
          } catch (e: any) {
            console.log(`[Debug] 第 ${i + 1} 秒，pgrep 也失败: ${e.message.split('\n')[0]}`);
          }
        }
      }

      if (!pid) {
        const err = '未能自动启动微信，或获取PID失败，请查看控制台日志或手动启动微信，看到登录窗口后点击确认。'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      onStatus?.(`捕获到微信 PID: ${pid}，准备获取密钥...`, 0)

      await new Promise(r => setTimeout(r, 2000))

      return await this.getDbKey(pid, onStatus, timeoutMs)
    } catch (err: any) {
      console.error('[Debug] 自动获取流程彻底崩溃:', err);
      const errMsg = '自动获取微信 PID 失败: ' + err.message
      onStatus?.(errMsg, 2)
      return { success: false, error: errMsg }
    }
  }

  public async getDbKey(pid: number, onStatus?: (message: string, level: number) => void, timeoutMs = 180_000): Promise<DbKeyResult> {
    try {
      const helperPath = this.getHelperPath()

      onStatus?.('正在扫描数据库基址...', 0)
      const { stdout: scanOut } = await execFileAsync(helperPath, ['db_scan', pid.toString()])
      const scanRes = JSON.parse(scanOut.trim())

      if (!scanRes.success) {
        const err = scanRes.result || '扫描失败，请确保微信已完全登录'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      const targetAddr = scanRes.target_addr
      onStatus?.('基址扫描成功，正在请求管理员权限进行内存 Hook...', 0)

      if (!this.sudo || typeof this.sudo.exec !== 'function') {
        const err = 'Linux 授权组件 @vscode/sudo-prompt 未加载，请确认依赖已安装并重新启动 WeFlow'
        onStatus?.(err, 2)
        return { success: false, error: err }
      }

      return await new Promise((resolve) => {
        const options = {
          name: 'WeFlow',
          env: {
            PATH: `${process.env.PATH || ''}:/bin:/usr/bin:/sbin:/usr/sbin:/usr/local/bin`
          }
        }
        const timeoutSec = Math.ceil((timeoutMs + 15_000) / 1000)
        const command = `timeout -k 5s ${timeoutSec}s "${helperPath}" db_hook ${pid} ${targetAddr} ${timeoutMs}`
        let settled = false
        const finish = (result: DbKeyResult) => {
          if (settled) return
          settled = true
          clearTimeout(watchdog)
          resolve(result)
        }
        const watchdog = setTimeout(() => {
          execAsync(`kill -CONT ${pid}`).catch(() => {})
          const err = `Hook 等待超时（${Math.round(timeoutMs / 1000)} 秒）。请确认微信登录确认已完成，或重启微信后重试。`
          onStatus?.(err, 2)
          finish({ success: false, error: err })
        }, timeoutMs + 30_000)

        onStatus?.('授权通过后请在手机上确认登录微信，正在等待密钥回调...', 0)

        this.sudo.exec(command, options, (error, stdout, stderr) => {
          execAsync(`kill -CONT ${pid}`).catch(() => {})
          if (error) {
            const detail = String(stderr || '').trim()
            const message = detail ? `${error.message}: ${detail}` : error.message
            onStatus?.('授权失败或 Hook 执行失败', 2)
            finish({ success: false, error: `授权失败或 Hook 执行失败: ${message}` })
            return
          }
          try {
            const output = String(stdout || '').trim()
            if (!output) {
              const detail = String(stderr || '').trim()
              throw new Error(detail ? `Hook 无输出: ${detail}` : 'Hook 无输出')
            }
            const hookRes = JSON.parse(output)
            if (hookRes.success) {
              onStatus?.('密钥获取成功', 1)
              finish({ success: true, key: hookRes.key })
            } else {
              onStatus?.(hookRes.result, 2)
              finish({ success: false, error: hookRes.result })
            }
          } catch (e: any) {
            onStatus?.('解析 Hook 结果失败', 2)
            finish({ success: false, error: e?.message || '解析 Hook 结果失败' })
          }
        })
      })
    } catch (err: any) {
      onStatus?.(err.message, 2)
      return { success: false, error: err.message }
    }
  }

  public async autoGetImageKey(
      accountPath?: string,
      onProgress?: (msg: string) => void,
      wxid?: string
  ): Promise<ImageKeyResult> {
    try {
      onProgress?.('正在初始化缓存扫描...');
      const helperPath = this.getHelperPath()
      const { stdout } = await execFileAsync(helperPath, ['image_local'])
      const res = JSON.parse(stdout.trim())
      if (!res.success) return { success: false, error: res.result }

      const accounts = res.data.accounts || []
      let account = accounts.find((a: any) => a.wxid === wxid)
      if (!account && accounts.length > 0) account = accounts[0]

      if (account && account.keys && account.keys.length > 0) {
        onProgress?.(`已找到匹配的图片密钥 (wxid: ${account.wxid})`);
        const keyObj = account.keys[0]
        const aesKey = String(keyObj.aesKey || '')
        const verified = await this.verifyImageKeyByTemplate(accountPath, aesKey)
        if (verified === true) {
          onProgress?.('缓存密钥校验成功，已确认可用')
        } else if (verified === false) {
          onProgress?.('已从缓存计算密钥，但未通过本地模板校验')
        }
        return { success: true, xorKey: keyObj.xorKey, aesKey, verified: verified === true }
      }
      return { success: false, error: '未在缓存中找到匹配的图片密钥' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  private async verifyImageKeyByTemplate(accountPath: string | undefined, aesKey: string): Promise<boolean | null> {
    const normalizedPath = String(accountPath || '').trim()
    if (!normalizedPath || !aesKey || aesKey.length < 16 || !existsSync(normalizedPath)) return null
    try {
      const template = await this._findTemplateData(normalizedPath, 32)
      if (!template.ciphertext) return null
      return this.verifyDerivedAesKey(aesKey, template.ciphertext)
    } catch {
      return null
    }
  }

  private verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
    try {
      if (!aesKey || aesKey.length < 16 || ciphertext.length !== 16) return false
      const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii').subarray(0, 16), null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) return true
      if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) return true
      if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return true
      if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return true
      if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return true
      return false
    } catch {
      return false
    }
  }

  public async autoGetImageKeyByMemoryScan(
      accountPath: string,
      onProgress?: (msg: string) => void
  ): Promise<ImageKeyResult> {
    try {
      onProgress?.('正在查找模板文件...')
      let result = await this._findTemplateData(accountPath, 32)
      let { ciphertext, xorKey } = result

      if (ciphertext && xorKey === null) {
        onProgress?.('未找到有效密钥，尝试扫描更多文件...')
        result = await this._findTemplateData(accountPath, 100)
        xorKey = result.xorKey
      }

      if (!ciphertext) return { success: false, error: '未找到 V2 模板文件，请先在微信中查看几张图片' }
      if (xorKey === null) return { success: false, error: '未能从模板文件中计算出有效的 XOR 密钥' }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      // 2. 找微信 PID
      const { stdout } = await execAsync('pidof wechat wechat-bin xwechat').catch(() => ({ stdout: '' }))
      const pids = stdout.trim().split(/\s+/).filter(p => p)
      if (pids.length === 0) return { success: false, error: '微信未运行，无法扫描内存' }
      const pid = parseInt(pids[0], 10)

      onProgress?.(`已找到微信进程 PID=${pid}，正在提权扫描进程内存...`);

      // 3. 将 Buffer 转换为 hex 传递给 helper
      const ciphertextHex = ciphertext.toString('hex')
      const helperPath = this.getHelperPath()

      try {
        console.log(`[Debug] 准备执行 Helper: ${helperPath} image_mem ${pid} ${ciphertextHex}`);

        const { stdout: memOut, stderr } = await execFileAsync(helperPath, ['image_mem', pid.toString(), ciphertextHex])

        console.log(`[Debug] Helper stdout: ${memOut}`);
        if (stderr) {
          console.warn(`[Debug] Helper stderr: ${stderr}`);
        }

        if (!memOut || memOut.trim() === '') {
          return { success: false, error: 'Helper 返回为空，请检查是否有足够的权限(如需sudo)读取进程内存。' }
        }

        const res = JSON.parse(memOut.trim())

        if (res.success) {
          onProgress?.('内存扫描成功');
          return { success: true, xorKey, aesKey: res.key }
        }
        return { success: false, error: res.result || '未知错误' }

      } catch (err: any) {
        console.error('[Debug] 执行或解析 Helper 时发生崩溃:', err);
        return {
          success: false,
          error: `内存扫描失败: ${err.message}\nstdout: ${err.stdout || '无'}\nstderr: ${err.stderr || '无'}`
        }
      }
    } catch (err: any) {
      return { success: false, error: `内存扫描失败: ${err.message}` }
    }
  }

  private async _findTemplateData(userDir: string, limit: number = 32): Promise<{ ciphertext: Buffer | null; xorKey: number | null }> {
    const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

    // 递归收集 *_t.dat 文件
    const collect = (dir: string, results: string[], maxFiles: number) => {
      if (results.length >= maxFiles) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) break
          const full = join(dir, entry.name)
          if (entry.isDirectory()) collect(full, results, maxFiles)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) results.push(full)
        }
      } catch { /* 忽略无权限目录 */ }
    }

    const files: string[] = []
    collect(userDir, files, limit)

    // 按修改时间降序
    files.sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
    })

    let ciphertext: Buffer | null = null
    const tailCounts: Record<string, number> = {}

    for (const f of files.slice(0, 32)) {
      try {
        const data = readFileSync(f)
        if (data.length < 8) continue

        // 统计末尾两字节用于 XOR 密钥
        if (data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 2) {
          const key = `${data[data.length - 2]}_${data[data.length - 1]}`
          tailCounts[key] = (tailCounts[key] ?? 0) + 1
        }

        // 提取密文（取第一个有效的）
        if (!ciphertext && data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 0x1F) {
          ciphertext = data.subarray(0xF, 0x1F)
        }
      } catch { /* 忽略 */ }
    }

    // 计算 XOR 密钥
    let xorKey: number | null = null
    let maxCount = 0
    for (const [key, count] of Object.entries(tailCounts)) {
      if (count > maxCount) {
        maxCount = count
        const [x, y] = key.split('_').map(Number)
        const k = x ^ 0xFF
        if (k === (y ^ 0xD9)) xorKey = k
      }
    }

    return { ciphertext, xorKey }
  }
}
