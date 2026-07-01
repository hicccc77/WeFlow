export const LOGIN_STARTUP_ARG = '--weflow-login-startup'

export type LaunchAtStartupSettings = {
  openAtLogin: boolean
  openAsHidden?: boolean
  path?: string
  args?: string[]
  enabled?: boolean
}

export type LaunchAtStartupQueryOptions = {
  path?: string
  args?: string[]
}

export type MacActivationPolicy = 'regular' | 'accessory'

export type MenuBarOnlyModeInput = {
  onboardingDone: boolean
  silentStartup: boolean
  hasTray: boolean
  mainWindowCreated: boolean
}

export type ActivateWindowInput = {
  menuBarOnlyMode: boolean
  hasMainWindow: boolean
}

export type TaskbarEntryInput = {
  platform: string
  menuBarOnlyMode: boolean
  windowVisible: boolean
}

export const shouldStartInBackground = (onboardingDone: boolean, silentStartup: boolean): boolean => {
  return onboardingDone && silentStartup
}

export const shouldUseMenuBarOnlyMode = ({
  onboardingDone,
  silentStartup,
  hasTray,
  mainWindowCreated
}: MenuBarOnlyModeInput): boolean => {
  if (!shouldStartInBackground(onboardingDone, silentStartup)) return false
  return hasTray || !mainWindowCreated
}

export const shouldShowWindowOnActivate = ({
  menuBarOnlyMode,
  hasMainWindow
}: ActivateWindowInput): boolean => {
  if (!hasMainWindow) return true
  return !menuBarOnlyMode
}

export const shouldSkipTaskbarEntry = ({
  platform,
  menuBarOnlyMode,
  windowVisible
}: TaskbarEntryInput): boolean => {
  return platform === 'win32' && menuBarOnlyMode && !windowVisible
}

export const buildLaunchAtStartupQueryOptions = (
  platform: string,
  execPath: string
): LaunchAtStartupQueryOptions | undefined => {
  if (platform !== 'win32') return undefined

  return {
    path: execPath,
    args: [LOGIN_STARTUP_ARG]
  }
}

export const buildLaunchAtStartupSettings = (
  enabled: boolean,
  platform: string,
  execPath: string
): LaunchAtStartupSettings => {
  if (platform === 'win32') {
    return {
      openAtLogin: enabled,
      path: execPath,
      args: [LOGIN_STARTUP_ARG],
      enabled
    }
  }

  if (platform === 'darwin') {
    return {
      openAtLogin: enabled
    }
  }

  return { openAtLogin: enabled }
}

export const getHiddenMacActivationPolicy = (isHidden: boolean): MacActivationPolicy => {
  return isHidden ? 'accessory' : 'regular'
}
