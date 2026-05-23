import { BrowserWindow, Tray } from 'electron'
import { ConfigService } from '../services/config'
import { LaunchAtStartupHelpers } from '../app/launchAtStartup'
import { AutoUpdateHelpers } from '../app/autoUpdateHelpers'
import { SnsCacheMigrationRuntime } from '../services/snsCacheMigration'

export interface OpenSessionChatWindowOptions {
  source?: 'chat' | 'export'
  initialDisplayName?: string
  initialAvatarUrl?: string
  initialContactType?: 'friend' | 'group' | 'official' | 'former_friend' | 'other'
}

export interface MainIpcContext {
  getConfigService: () => ConfigService | null
  setConfigService: (service: ConfigService | null) => void
  getMainWindow: () => BrowserWindow | null
  getTray: () => Tray | null
  getIsAppQuitting: () => boolean
  setIsAppQuitting: (value: boolean) => void
  getIsClosePromptVisible: () => boolean
  setIsClosePromptVisible: (value: boolean) => void
  setShouldShowMain: (value: boolean) => void
  createVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => void
  createChatHistoryWindow: (sessionId: string, messageId: number) => void
  createChatHistoryPayloadWindow: (payloadId: string) => BrowserWindow
  createSessionChatWindow: (sessionId: string, options?: OpenSessionChatWindowOptions) => BrowserWindow | null
  createAgreementWindow: () => BrowserWindow
  createImageViewerWindow: (imagePath: string, liveVideoPath?: string) => void
  createOnboardingWindow: (mode?: 'default' | 'add-account') => BrowserWindow
  closeOnboardingWindow: () => void
  showMainWindow: () => void
  launchAtStartup: LaunchAtStartupHelpers
  autoUpdate: AutoUpdateHelpers
  snsMigration: SnsCacheMigrationRuntime
  keyService: any
  ensureNotificationNavigateHandlerRegistered: () => void
}
