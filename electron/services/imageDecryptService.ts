import { app } from 'electron'
import { dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { ConfigService } from './config'

type DecryptResult = { success: boolean; localPath?: string; error?: string }

type HardlinkState = {
  db: Database.Database
  imageTable?: string
  dirTable?: string
}

export class ImageDecryptService {
  private configService = new ConfigService()
  private hardlinkCache = new Map<string, HardlinkState>()
  private resolvedCache = new Map<string, string>()
  private pending = new Map<string, Promise<DecryptResult>>()
  private readonly defaultV1AesKey = 'cfcd208495d565ef'

  async decryptImage(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }): Promise<DecryptResult> {
    const cacheKey = payload.imageMd5 || payload.imageDatName
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }

    const cached = this.resolvedCache.get(cacheKey)
    if (cached && existsSync(cached)) {
      return { success: true, localPath: pathToFileURL(cached).toString() }
    }

    const pending = this.pending.get(cacheKey)
    if (pending) return pending

    const task = this.decryptImageInternal(payload, cacheKey)
    this.pending.set(cacheKey, task)
    try {
      return await task
    } finally {
      this.pending.delete(cacheKey)
    }
  }

  private async decryptImageInternal(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string },
    cacheKey: string
  ): Promise<DecryptResult> {
    try {
      const wxid = this.configService.get('myWxid')
      const dbPath = this.configService.get('dbPath')
      if (!wxid || !dbPath) {
        return { success: false, error: '未配置账号或数据库路径' }
      }

      const accountDir = this.resolveAccountDir(dbPath, wxid)
      if (!accountDir) {
        return { success: false, error: '未找到账号目录' }
      }

      const datPath = await this.resolveDatPath(
        accountDir,
        payload.imageMd5,
        payload.imageDatName,
        payload.sessionId
      )
      if (!datPath) {
        return { success: false, error: '未找到图片文件' }
      }

      if (!extname(datPath).toLowerCase().includes('dat')) {
        this.resolvedCache.set(cacheKey, datPath)
        return { success: true, localPath: pathToFileURL(datPath).toString() }
      }

      const existing = this.findCachedOutput(cacheKey)
      if (existing) {
        this.resolvedCache.set(cacheKey, existing)
        return { success: true, localPath: pathToFileURL(existing).toString() }
      }

      const xorKey = this.configService.get('imageXorKey')
      if (!xorKey) {
        return { success: false, error: '未配置图片 XOR 密钥' }
      }

      const aesKeyRaw = this.configService.get('imageAesKey')
      const aesKey = this.resolveAesKey(aesKeyRaw)

      const decrypted = await this.decryptDatAuto(datPath, xorKey, aesKey)
      const ext = this.detectImageExtension(decrypted) || '.jpg'

      const outputPath = join(this.getCacheRoot(), `${cacheKey}${ext}`)
      await writeFile(outputPath, decrypted)
      this.resolvedCache.set(cacheKey, outputPath)
      return { success: true, localPath: pathToFileURL(outputPath).toString() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private resolveAccountDir(dbPath: string, wxid: string): string | null {
    const cleanedWxid = this.cleanAccountDirName(wxid)
    const normalized = dbPath.replace(/[\\/]+$/, '')

    const direct = join(normalized, cleanedWxid)
    if (existsSync(direct)) return direct

    if (this.isAccountDir(normalized)) return normalized

    try {
      const entries = readdirSync(normalized)
      const lowerWxid = cleanedWxid.toLowerCase()
      for (const entry of entries) {
        const entryPath = join(normalized, entry)
        if (!this.isDirectory(entryPath)) continue
        const lowerEntry = entry.toLowerCase()
        if (lowerEntry === lowerWxid || lowerEntry.startsWith(`${lowerWxid}_`)) {
          if (this.isAccountDir(entryPath)) return entryPath
        }
      }
    } catch {}

    return null
  }

  private isAccountDir(dirPath: string): boolean {
    return (
      existsSync(join(dirPath, 'hardlink.db')) ||
      existsSync(join(dirPath, 'db_storage')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image2'))
    )
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  private cleanAccountDirName(dirName: string): string {
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

  private async resolveDatPath(
    accountDir: string,
    imageMd5?: string,
    imageDatName?: string,
    sessionId?: string
  ): Promise<string | null> {
    if (imageMd5) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath) return hardlinkPath
    }

    if (!imageDatName) return null
    const cached = this.resolvedCache.get(imageDatName)
    if (cached && existsSync(cached)) return cached

    const datPath = await this.searchDatFile(accountDir, imageDatName)
    if (datPath) {
      this.resolvedCache.set(imageDatName, datPath)
    }
    return datPath
  }

  private resolveHardlinkPath(accountDir: string, md5: string, sessionId?: string): string | null {
    try {
      const hardlinkPath = join(accountDir, 'hardlink.db')
      if (!existsSync(hardlinkPath)) return null

      const state = this.getHardlinkState(accountDir, hardlinkPath)
      if (!state.imageTable) return null

      const row = state.db
        .prepare(`SELECT dir1, dir2, file_name FROM ${state.imageTable} WHERE md5 = ? LIMIT 1`)
        .get(md5)

      if (!row) return null
      const dir1 = row.dir1 as string | undefined
      const dir2 = row.dir2 as string | undefined
      const fileName = row.file_name as string | undefined
      if (!dir1 || !dir2 || !fileName) return null

      let dirName = dir2
      if (state.dirTable && sessionId) {
        try {
          const dirRow = state.db
            .prepare(`SELECT dir_name FROM ${state.dirTable} WHERE dir_id = ? AND username = ? LIMIT 1`)
            .get(dir2, sessionId)
          if (dirRow?.dir_name) dirName = dirRow.dir_name as string
        } catch {}
      }

      const fullPath = join(accountDir, dir1, dirName, fileName)
      if (existsSync(fullPath)) return fullPath

      const withDat = `${fullPath}.dat`
      if (existsSync(withDat)) return withDat
    } catch {}
    return null
  }

  private getHardlinkState(accountDir: string, hardlinkPath: string): HardlinkState {
    const cached = this.hardlinkCache.get(accountDir)
    if (cached) return cached

    const db = new Database(hardlinkPath, { readonly: true, fileMustExist: true })
    const imageRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'image_hardlink_info%' ORDER BY name DESC LIMIT 1")
      .get()
    const dirRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dir2id%' LIMIT 1")
      .get()
    const state: HardlinkState = {
      db,
      imageTable: imageRow?.name as string | undefined,
      dirTable: dirRow?.name as string | undefined
    }
    this.hardlinkCache.set(accountDir, state)
    return state
  }

  private async searchDatFile(accountDir: string, datName: string): Promise<string | null> {
    const key = `${accountDir}|${datName}`
    const cached = this.resolvedCache.get(key)
    if (cached && existsSync(cached)) return cached

    const roots = [
      join(accountDir, 'FileStorage', 'Image'),
      join(accountDir, 'FileStorage', 'Image2')
    ]
    for (const root of roots) {
      if (!existsSync(root)) continue
      const found = this.walkForDat(root, datName.toLowerCase())
      if (found) {
        this.resolvedCache.set(key, found)
        return found
      }
    }
    return null
  }

  private walkForDat(root: string, datName: string): string | null {
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
    const maxDepth = 4
    let best: { score: number; path: string } | null = null

    while (stack.length) {
      const current = stack.pop() as { dir: string; depth: number }
      let entries: string[]
      try {
        entries = readdirSync(current.dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const entryPath = join(current.dir, entry)
        let stat
        try {
          stat = statSync(entryPath)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          if (current.depth < maxDepth) {
            stack.push({ dir: entryPath, depth: current.depth + 1 })
          }
          continue
        }
        const lower = entry.toLowerCase()
        if (!lower.endsWith('.dat')) continue
        if (!this.matchesDatName(lower, datName)) continue
        const score = this.scoreDatName(lower)
        if (!best || score > best.score) {
          best = { score, path: entryPath }
        }
      }
    }
    return best?.path ?? null
  }

  private matchesDatName(fileName: string, datName: string): boolean {
    const base = fileName.toLowerCase()
    const pattern = new RegExp(`^${datName}(?:[._][a-z])?\\.dat$`)
    return pattern.test(base)
  }

  private scoreDatName(fileName: string): number {
    if (fileName.includes('.t.dat') || fileName.includes('_t.dat')) return 1
    return 2
  }

  private findCachedOutput(cacheKey: string): string | null {
    const root = this.getCacheRoot()
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
    for (const ext of extensions) {
      const candidate = join(root, `${cacheKey}${ext}`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private getCacheRoot(): string {
    const configured = this.configService.get('cachePath')
    const root = configured ? join(configured, 'Images') : join(app.getPath('userData'), 'cache', 'images')
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true })
    }
    return root
  }

  private resolveAesKey(aesKeyRaw: string): Buffer | null {
    const trimmed = aesKeyRaw?.trim() ?? ''
    if (!trimmed) return null
    if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex')
    }
    if (trimmed.length >= 16) {
      return Buffer.from(trimmed, 'ascii').subarray(0, 16)
    }
    return null
  }

  private async decryptDatAuto(datPath: string, xorKey: number, aesKey: Buffer | null): Promise<Buffer> {
    const bytes = await readFile(datPath)
    const version = this.getDatVersion(bytes)
    if (version === 0) return this.decryptDatV3(bytes, xorKey)
    if (version === 1) {
      const key = Buffer.from(this.defaultV1AesKey, 'ascii').subarray(0, 16)
      return this.decryptDatV4(bytes, xorKey, key)
    }
    if (!aesKey || aesKey.length < 16) {
      throw new Error('V4 图片需要 AES 密钥')
    }
    return this.decryptDatV4(bytes, xorKey, aesKey)
  }

  private getDatVersion(bytes: Buffer): number {
    if (bytes.length < 6) return 0
    const signature = bytes.subarray(0, 6)
    if (this.compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]))) {
      return 1
    }
    if (this.compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]))) {
      return 2
    }
    return 0
  }

  private decryptDatV3(bytes: Buffer, xorKey: number): Buffer {
    const out = Buffer.alloc(bytes.length)
    for (let i = 0; i < bytes.length; i += 1) {
      out[i] = bytes[i] ^ xorKey
    }
    return out
  }

  private decryptDatV4(bytes: Buffer, xorKey: number, aesKey: Buffer): Buffer {
    if (bytes.length < 0x0f) {
      throw new Error('文件太小，无法解析')
    }

    const header = bytes.subarray(0, 0x0f)
    const data = bytes.subarray(0x0f)
    const aesSize = header.readInt32LE(6)
    const xorSize = header.readInt32LE(10)

    const remainder = aesSize % 16
    const alignedAesSize = aesSize + (16 - remainder)
    if (alignedAesSize > data.length) {
      throw new Error('文件格式异常：AES 数据长度超过文件实际长度')
    }

    const aesData = data.subarray(0, alignedAesSize)
    let unpadded = Buffer.alloc(0)
    if (aesData.length > 0) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])
      unpadded = this.strictRemovePadding(decrypted)
    }

    const remaining = data.subarray(alignedAesSize)
    if (xorSize < 0 || xorSize > remaining.length) {
      throw new Error('文件格式异常：XOR 数据长度不合法')
    }

    let rawData = Buffer.alloc(0)
    let xoredData = Buffer.alloc(0)
    if (xorSize > 0) {
      const rawLength = remaining.length - xorSize
      if (rawLength < 0) {
        throw new Error('文件格式异常：原始数据长度小于XOR长度')
      }
      rawData = remaining.subarray(0, rawLength)
      const xorData = remaining.subarray(rawLength)
      xoredData = Buffer.alloc(xorData.length)
      for (let i = 0; i < xorData.length; i += 1) {
        xoredData[i] = xorData[i] ^ xorKey
      }
    } else {
      rawData = remaining
    }

    return Buffer.concat([unpadded, rawData, xoredData])
  }

  private strictRemovePadding(data: Buffer): Buffer {
    if (!data.length) {
      throw new Error('解密结果为空，填充非法')
    }
    const paddingLength = data[data.length - 1]
    if (paddingLength === 0 || paddingLength > 16 || paddingLength > data.length) {
      throw new Error('PKCS7 填充长度非法')
    }
    for (let i = data.length - paddingLength; i < data.length; i += 1) {
      if (data[i] !== paddingLength) {
        throw new Error('PKCS7 填充内容非法')
      }
    }
    return data.subarray(0, data.length - paddingLength)
  }

  private detectImageExtension(buffer: Buffer): string | null {
    if (buffer.length < 12) return null
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return '.gif'
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png'
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return '.webp'
    }
    return null
  }

  private compareBytes(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false
    }
    return true
  }
}

export const imageDecryptService = new ImageDecryptService()
