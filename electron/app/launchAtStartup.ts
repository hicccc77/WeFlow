import { app } from 'electron'
import { ConfigService } from '../services/config'

export function createLaunchAtStartupHelpers(getConfigService: () => ConfigService | null) {
  const getLaunchAtStartupUnsupportedReason = (): string | null => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return '当前平台暂不支持开机自启动'
    }
    if (!app.isPackaged) {
      return '仅安装后的 Windows / macOS 版本支持开机自启动'
    }
    return null
  }

  const isLaunchAtStartupSupported = (): boolean => getLaunchAtStartupUnsupportedReason() == null

  const getStoredLaunchAtStartupPreference = (): boolean | undefined => {
    const value = getConfigService()?.get('launchAtStartup')
    return typeof value === 'boolean' ? value : undefined
  }

  const getSystemLaunchAtStartup = (): boolean => {
    if (!isLaunchAtStartupSupported()) return false
    try {
      return app.getLoginItemSettings().openAtLogin === true
    } catch (error) {
      console.error('[WeFlow] 读取开机自启动状态失败:', error)
      return false
    }
  }

  const buildLaunchAtStartupSettings = (enabled: boolean): Parameters<typeof app.setLoginItemSettings>[0] =>
    process.platform === 'win32'
      ? { openAtLogin: enabled, path: process.execPath }
      : { openAtLogin: enabled }

  const setSystemLaunchAtStartup = (enabled: boolean): { success: boolean; enabled: boolean; error?: string } => {
    try {
      app.setLoginItemSettings(buildLaunchAtStartupSettings(enabled))
      const effectiveEnabled = app.getLoginItemSettings().openAtLogin === true
      if (effectiveEnabled !== enabled) {
        return {
          success: false,
          enabled: effectiveEnabled,
          error: '系统未接受该开机自启动设置'
        }
      }
      return { success: true, enabled: effectiveEnabled }
    } catch (error) {
      return {
        success: false,
        enabled: getSystemLaunchAtStartup(),
        error: `设置开机自启动失败: ${String((error as Error)?.message || error)}`
      }
    }
  }

  const getLaunchAtStartupStatus = (): { enabled: boolean; supported: boolean; reason?: string } => {
    const unsupportedReason = getLaunchAtStartupUnsupportedReason()
    if (unsupportedReason) {
      return {
        enabled: getStoredLaunchAtStartupPreference() === true,
        supported: false,
        reason: unsupportedReason
      }
    }
    return {
      enabled: getSystemLaunchAtStartup(),
      supported: true
    }
  }

  const applyLaunchAtStartupPreference = (
    enabled: boolean
  ): { success: boolean; enabled: boolean; supported: boolean; reason?: string; error?: string } => {
    const unsupportedReason = getLaunchAtStartupUnsupportedReason()
    if (unsupportedReason) {
      return {
        success: false,
        enabled: getStoredLaunchAtStartupPreference() === true,
        supported: false,
        reason: unsupportedReason
      }
    }

    const result = setSystemLaunchAtStartup(enabled)
    getConfigService()?.set('launchAtStartup', result.enabled)
    return {
      ...result,
      supported: true
    }
  }

  const syncLaunchAtStartupPreference = () => {
    const configService = getConfigService()
    if (!configService) return

    const unsupportedReason = getLaunchAtStartupUnsupportedReason()
    if (unsupportedReason) return

    const storedPreference = getStoredLaunchAtStartupPreference()
    const systemEnabled = getSystemLaunchAtStartup()

    if (typeof storedPreference !== 'boolean') {
      configService.set('launchAtStartup', systemEnabled)
      return
    }

    if (storedPreference === systemEnabled) return

    const result = setSystemLaunchAtStartup(storedPreference)
    configService.set('launchAtStartup', result.enabled)
    if (!result.success && result.error) {
      console.error('[WeFlow] 同步开机自启动设置失败:', result.error)
    }
  }

  return {
    isLaunchAtStartupSupported,
    getSystemLaunchAtStartup,
    setSystemLaunchAtStartup,
    getLaunchAtStartupStatus,
    applyLaunchAtStartupPreference,
    syncLaunchAtStartupPreference
  }
}

export type LaunchAtStartupHelpers = ReturnType<typeof createLaunchAtStartupHelpers>
