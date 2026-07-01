import assert from 'node:assert/strict'

import {
  LOGIN_STARTUP_ARG,
  buildLaunchAtStartupQueryOptions,
  buildLaunchAtStartupSettings,
  getHiddenMacActivationPolicy,
  shouldShowWindowOnActivate,
  shouldSkipTaskbarEntry,
  shouldStartInBackground,
  shouldUseMenuBarOnlyMode
} from '../electron/startupBehavior.ts'

assert.equal(shouldStartInBackground(true, true), true, 'silent startup should hide after onboarding')
assert.equal(shouldStartInBackground(false, true), false, 'first launch must show onboarding')
assert.equal(shouldStartInBackground(true, false), false, 'non-silent startup should show UI')
assert.equal(
  shouldUseMenuBarOnlyMode({
    onboardingDone: true,
    silentStartup: true,
    hasTray: false,
    mainWindowCreated: false
  }),
  true,
  'macOS should hide Dock during early silent startup before tray creation'
)
assert.equal(
  shouldUseMenuBarOnlyMode({
    onboardingDone: true,
    silentStartup: true,
    hasTray: true,
    mainWindowCreated: true
  }),
  true,
  'macOS should stay menu-bar-only after tray creation succeeds'
)
assert.equal(
  shouldUseMenuBarOnlyMode({
    onboardingDone: true,
    silentStartup: true,
    hasTray: false,
    mainWindowCreated: true
  }),
  false,
  'macOS should restore Dock if tray creation failed after the main window exists'
)
assert.equal(
  shouldShowWindowOnActivate({ menuBarOnlyMode: true, hasMainWindow: true }),
  false,
  'macOS activate should not show the main window while in menu-bar-only mode'
)
assert.equal(
  shouldShowWindowOnActivate({ menuBarOnlyMode: false, hasMainWindow: true }),
  true,
  'macOS activate should show the main window in normal mode'
)
assert.equal(
  shouldSkipTaskbarEntry({ platform: 'win32', menuBarOnlyMode: true, windowVisible: false }),
  true,
  'Windows tray-only mode should hide a background main window from the taskbar'
)
assert.equal(
  shouldSkipTaskbarEntry({ platform: 'win32', menuBarOnlyMode: true, windowVisible: true }),
  false,
  'Windows tray restore should show the foreground main window in the taskbar'
)
assert.equal(
  shouldSkipTaskbarEntry({ platform: 'linux', menuBarOnlyMode: true, windowVisible: false }),
  false,
  'Linux fallback should keep a shown window reachable from the taskbar'
)
assert.equal(
  shouldSkipTaskbarEntry({ platform: 'darwin', menuBarOnlyMode: true, windowVisible: false }),
  false,
  'macOS Dock visibility is controlled by activation policy, not skipTaskbar'
)
assert.equal(
  shouldSkipTaskbarEntry({ platform: 'win32', menuBarOnlyMode: false, windowVisible: false }),
  false,
  'Windows normal mode should keep the main window in the taskbar'
)

assert.deepEqual(
  buildLaunchAtStartupQueryOptions('win32', 'C:\\Program Files\\WeFlow\\WeFlow.exe'),
  {
    path: 'C:\\Program Files\\WeFlow\\WeFlow.exe',
    args: [LOGIN_STARTUP_ARG]
  },
  'Windows login item status should query the arg-qualified entry'
)

assert.equal(
  buildLaunchAtStartupQueryOptions('darwin', '/Applications/WeFlow.app/Contents/MacOS/WeFlow'),
  undefined,
  'macOS login item status should use Electron defaults'
)

assert.deepEqual(
  buildLaunchAtStartupSettings(true, 'win32', 'C:\\Program Files\\WeFlow\\WeFlow.exe'),
  {
    openAtLogin: true,
    path: 'C:\\Program Files\\WeFlow\\WeFlow.exe',
    args: [LOGIN_STARTUP_ARG],
    enabled: true
  },
  'Windows login item should launch hidden through an explicit arg'
)

assert.deepEqual(
  buildLaunchAtStartupSettings(false, 'win32', 'C:\\Program Files\\WeFlow\\WeFlow.exe'),
  {
    openAtLogin: false,
    path: 'C:\\Program Files\\WeFlow\\WeFlow.exe',
    args: [LOGIN_STARTUP_ARG],
    enabled: false
  },
  'Windows login item disable should target the same arg-qualified entry'
)

assert.deepEqual(
  buildLaunchAtStartupSettings(true, 'darwin', '/Applications/WeFlow.app/Contents/MacOS/WeFlow'),
  {
    openAtLogin: true
  },
  'macOS login item should stay minimal because runtime controls hidden startup'
)

assert.deepEqual(
  buildLaunchAtStartupSettings(true, 'linux', '/usr/bin/weflow'),
  {
    openAtLogin: true
  },
  'other platforms keep the generic Electron shape'
)

assert.equal(getHiddenMacActivationPolicy(true), 'accessory', 'hidden macOS mode should not show a Dock icon')
assert.equal(getHiddenMacActivationPolicy(false), 'regular', 'non-silent macOS mode should keep normal app behavior')

console.log('startup behavior tests passed')
