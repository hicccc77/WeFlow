import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
// import { ConfigService } from './config'

const execFileAsync = promisify(execFile)

export class ImageDownloadService {
  private static instance: ImageDownloadService
  private koffi: any = null
  private lib: any = null
  private initialized = false

  private initImgHelper: any = null
  private uninstallImgHelper: any = null
  private getImgHelperError: any = null

  private currentPid: number | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private isHooked = false

  private lastWhitelist: string[] = []

  static getInstance(): ImageDownloadService {
    if (!ImageDownloadService.instance) {
      ImageDownloadService.instance = new ImageDownloadService()
    }
    return ImageDownloadService.instance
  }

  private constructor() {
  }

  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return true
    if (process.platform !== 'win32' || process.arch !== 'x64') return false

    try {
      this.koffi = require('koffi')
      const dllPath = this.getDllPath()
      if (!existsSync(dllPath)) return false

      this.lib = this.koffi.load(dllPath)

      this.initImgHelper = this.lib.func('bool InitImgHelper(uint32, const char*)')
      this.uninstallImgHelper = this.lib.func('void UninstallImgHelper()')
      this.getImgHelperError = this.lib.func('const char* GetImgHelperError()')

      this.initialized = true
      return true
    } catch (error) {
      console.error('[ImageDownloadService] failed to initialize:', error)
      return false
    }
  }

  private getDllPath(): string {
    const isPackaged = app.isPackaged
    const candidates: string[] = []
    
    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'image', 'win32', 'x64', 'img_helper.dll'))
    } else {
      candidates.push(join(process.cwd(), 'resources', 'image', 'win32', 'x64', 'img_helper.dll'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }
    return candidates[0]
  }

  private async findMainWeChatPid(): Promise<number | null> {
    try {
      const script = `
      Get-CimInstance Win32_Process -Filter "Name = 'Weixin.exe'" | 
      Select-Object ProcessId, CommandLine | 
      ConvertTo-Json -Compress
    `;

      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script])
      if (!stdout || !stdout.trim()) return null

      let processes = JSON.parse(stdout.trim())
      if (!Array.isArray(processes)) processes = [processes]

      const target = processes
          .filter((p: any) => p.CommandLine && p.CommandLine.toLowerCase().includes('weixin.exe'))
          .sort((a: any, b: any) => a.CommandLine.length - b.CommandLine.length)[0]

      return target ? target.ProcessId : null;
    } catch (e) {
      return null
    }
  }

  async startAutoDownload(whitelist: string[] | string = []): Promise<{ success: boolean; error?: string }> {
    if (!await this.ensureInitialized()) {
      return { success: false, error: '核心组件初始化失败' }
    }

    if (this.isHooked) {
      await this.unhook()
    }

    this.lastWhitelist = whitelist

    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.checkAndHook(this.lastWhitelist, false), 30000)
    }

    return await this.checkAndHook(whitelist, true)
  }

  async stopAutoDownload() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    await this.unhook()
  }

  private async checkAndHook(whitelist: string[] | string = [], isManualStart = false): Promise<{ success: boolean; error?: string }> {
    const pid = await this.findMainWeChatPid()

    if (!pid) {
      if (this.isHooked) {
        console.log('[ImageDownloadService] WeChat exited, unhooking')
        await this.unhook()
      }
      return { success: true, error: '等待微信启动' }
    }

    if (this.isHooked && this.currentPid === pid) {
      return { success: true }
    }

    if (this.isHooked && this.currentPid !== pid) {
      console.log('[ImageDownloadService] WeChat PID changed, re-hooking')
      await this.unhook()
    }

    console.log(`[ImageDownloadService] attempting to hook PID: ${pid}`)
    try {
      let whitelistBuffer: Buffer | null = null;
      if (typeof whitelist === 'string') {
        if (whitelist.length > 0) {
          whitelistBuffer = Buffer.from(whitelist, 'utf8');
        }
      } else if (Array.isArray(whitelist) && whitelist.length > 0) {
        whitelistBuffer = Buffer.from(whitelist.join('\0') + '\0\0', 'utf8');
      }

      const success = this.initImgHelper(pid, whitelistBuffer)

      if (success) {
        this.isHooked = true
        this.currentPid = pid
        console.log('[ImageDownloadService] hook successful')
        return { success: true }
      } else {
        const err = this.getImgHelperError()
        console.error(`[ImageDownloadService] hook failed: ${err}`)
        if (isManualStart && this.pollTimer) {
          clearInterval(this.pollTimer)
          this.pollTimer = null
        }
        return { success: false, error: err || 'Hook 失败' }
      }
    } catch (e: any) {
      console.error('[ImageDownloadService] InitImgHelper call crashed:', e)
      if (isManualStart && this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
      return { success: false, error: `调用异常: ${e.message || String(e)}` }
    }
  }

  private async unhook() {
    if (this.isHooked && this.uninstallImgHelper) {
      try {
        this.uninstallImgHelper()
      } catch (e) {
        console.error('[ImageDownloadService] uninstall failed:', e)
      }
    }
    this.isHooked = false
    this.currentPid = null
  }

  async getStatus() {
    return {
      isHooked: this.isHooked,
      pid: this.currentPid,
      supported: process.platform === 'win32' && process.arch === 'x64'
    }
  }
}

export const imageDownloadService = ImageDownloadService.getInstance()
