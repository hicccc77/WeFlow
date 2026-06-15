import { app } from 'electron'
import { wcdbService } from './wcdbService'

interface UsageStats {
  appVersion: string
  platform: string
  deviceId: string
  timestamp: number
  online: boolean
  pages: string[]
}

class CloudControlService {
  private deviceId: string = ''
  private timer: NodeJS.Timeout | null = null
  private pages: Set<string> = new Set()
  private platformVersionCache: string | null = null
  private pendingReports: UsageStats[] = []
  private flushInProgress = false
  private retryDelayMs = 5_000
  private consecutiveFailures = 0
  private circuitOpenedAt = 0
  private nextDelayOverrideMs: number | null = null
  private initialized = false

  private static readonly BASE_FLUSH_MS = 300_000
  private static readonly JITTER_MS = 30_000
  private static readonly MAX_BUFFER_REPORTS = 200
  private static readonly MAX_BATCH_REPORTS = 20
  private static readonly MAX_RETRY_MS = 120_000
  private static readonly CIRCUIT_FAIL_THRESHOLD = 5
  private static readonly CIRCUIT_COOLDOWN_MS = 120_000

  async init() {
    if (this.initialized) return
    this.initialized = true
    this.deviceId = this.getDeviceId()
    await wcdbService.cloudInit(300)
    this.enqueueCurrentReport()
    await this.flushQueue(true)
    this.scheduleNextFlush(this.nextDelayOverrideMs ?? undefined)
    this.nextDelayOverrideMs = null
  }

  private getDeviceId(): string {
    const crypto = require('crypto')
    const os = require('os')
    const machineId = os.hostname() + os.platform() + os.arch()
    return crypto.createHash('md5').update(machineId).digest('hex')
  }

  private buildCurrentReport(): UsageStats {
    return {
      appVersion: app.getVersion(),
      platform: this.getPlatformVersion(),
      deviceId: this.deviceId,
      timestamp: Date.now(),
      online: true,
      pages: Array.from(this.pages)
    }
  }

  private enqueueCurrentReport() {
    const report = this.buildCurrentReport()
    this.pendingReports.push(report)
    if (this.pendingReports.length > CloudControlService.MAX_BUFFER_REPORTS) {
      this.pendingReports.splice(0, this.pendingReports.length - CloudControlService.MAX_BUFFER_REPORTS)
    }
    this.pages.clear()
  }

  private isCircuitOpen(nowMs: number): boolean {
    if (this.circuitOpenedAt <= 0) return false
    return nowMs-this.circuitOpenedAt < CloudControlService.CIRCUIT_COOLDOWN_MS
  }

  private scheduleNextFlush(delayMs?: number) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const jitter = Math.floor(Math.random() * CloudControlService.JITTER_MS)
    const nextDelay = Math.max(1_000, Number(delayMs) > 0 ? Number(delayMs) : CloudControlService.BASE_FLUSH_MS + jitter)
    this.timer = setTimeout(() => {
      this.enqueueCurrentReport()
      this.flushQueue(false).finally(() => {
        this.scheduleNextFlush(this.nextDelayOverrideMs ?? undefined)
        this.nextDelayOverrideMs = null
      })
    }, nextDelay)
  }

  private async flushQueue(force: boolean) {
    if (this.flushInProgress) return
    if (this.pendingReports.length === 0) return
    const now = Date.now()
    if (!force && this.isCircuitOpen(now)) {
      return
    }
    this.flushInProgress = true
    try {
      while (this.pendingReports.length > 0) {
        const batch = this.pendingReports.slice(0, CloudControlService.MAX_BATCH_REPORTS)
        const result = await wcdbService.cloudReport(JSON.stringify(batch))
        if (!result || result.success !== true) {
          this.consecutiveFailures += 1
          this.retryDelayMs = Math.min(CloudControlService.MAX_RETRY_MS, this.retryDelayMs * 2)
          if (this.consecutiveFailures >= CloudControlService.CIRCUIT_FAIL_THRESHOLD) {
            this.circuitOpenedAt = Date.now()
          }
          this.nextDelayOverrideMs = this.retryDelayMs
          return
        }
        this.pendingReports.splice(0, batch.length)
        this.consecutiveFailures = 0
        this.retryDelayMs = 5_000
        this.circuitOpenedAt = 0
      }
    } finally {
      this.flushInProgress = false
    }
  }

  private getPlatformVersion(): string {
    if (this.platformVersionCache) {
      return this.platformVersionCache
    }

    const os = require('os')
    const fs = require('fs')
    const platform = process.platform

    if (platform === 'win32') {
      const release = os.release()
      const parts = release.split('.')
      const major = parseInt(parts[0])
      const minor = parseInt(parts[1] || '0')
      const build = parseInt(parts[2] || '0')

      // Windows 11 是 10.0.22000+，且主版本必须是 10.0
      if (major === 10 && minor === 0 && build >= 22000) {
        this.platformVersionCache = 'Windows 11'
        return this.platformVersionCache
      } else if (major === 10) {
        this.platformVersionCache = 'Windows 10'
        return this.platformVersionCache
      }
      this.platformVersionCache = `Windows ${release}`
      return this.platformVersionCache
    }

    if (platform === 'darwin') {
      // `os.release()` returns Darwin kernel version (e.g. 25.3.0),
      // while cloud reporting expects the macOS product version (e.g. 26.3).
      const macVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release()
      this.platformVersionCache = `macOS ${macVersion}`
      return this.platformVersionCache
    }

    if (platform === 'linux') {
      try {
        const osReleasePaths = ['/etc/os-release', '/usr/lib/os-release']
        for (const filePath of osReleasePaths) {
          if (!fs.existsSync(filePath)) {
            continue
          }

          const content = fs.readFileSync(filePath, 'utf8')
          const values: Record<string, string> = {}

          for (const line of content.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) {
              continue
            }

            const separatorIndex = trimmed.indexOf('=')
            if (separatorIndex <= 0) {
              continue
            }

            const key = trimmed.slice(0, separatorIndex)
            let value = trimmed.slice(separatorIndex + 1).trim()
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
              value = value.slice(1, -1)
            }
            values[key] = value
          }

          if (values.PRETTY_NAME) {
            this.platformVersionCache = values.PRETTY_NAME
            return this.platformVersionCache
          }

          if (values.NAME && values.VERSION_ID) {
            this.platformVersionCache = `${values.NAME} ${values.VERSION_ID}`
            return this.platformVersionCache
          }

          if (values.NAME) {
            this.platformVersionCache = values.NAME
            return this.platformVersionCache
          }
        }
      } catch (error) {
        console.warn('[CloudControl] Failed to detect Linux distro version:', error)
      }

      this.platformVersionCache = `Linux ${os.release()}`
      return this.platformVersionCache
    }

    this.platformVersionCache = platform
    return this.platformVersionCache
  }

  recordPage(pageName: string) {
    this.pages.add(pageName)
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pendingReports = []
    this.flushInProgress = false
    this.retryDelayMs = 5_000
    this.consecutiveFailures = 0
    this.circuitOpenedAt = 0
    this.nextDelayOverrideMs = null
    this.initialized = false
    if (wcdbService.isReady()) {
      try {
        await wcdbService.cloudStop()
      } catch {
        // 忽略停止失败，避免阻塞主进程退出
      }
    }
  }

  async getLogs() {
    return wcdbService.getLogs()
  }
}

export const cloudControlService = new CloudControlService()
