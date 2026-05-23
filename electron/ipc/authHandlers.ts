import { BrowserWindow, ipcMain } from 'electron'
import { windowsHelloService } from '../services/windowsHelloService'
import { MainIpcContext } from './mainIpcContext'

export function registerAuthHandlers(ctx: MainIpcContext) {
  ipcMain.handle('auth:hello', async (event, message?: string) => {
    const targetWin = (ctx.getMainWindow() && !ctx.getMainWindow()!.isDestroyed())
      ? ctx.getMainWindow()!
      : (BrowserWindow.fromWebContents(event.sender) || undefined)

    const result = await windowsHelloService.verify(message, targetWin)

    if (result && ctx.getConfigService()) {
      const configService = ctx.getConfigService()!
      const secret = configService.getHelloSecret()
      if (secret && configService.isLockMode()) {
        configService.unlock(secret)
      }
    }

    return result
  })

  ipcMain.handle('auth:verifyEnabled', async () => {
    return ctx.getConfigService()?.verifyAuthEnabled() ?? false
  })

  ipcMain.handle('auth:unlock', async (_event, password: string) => {
    if (!ctx.getConfigService()) return { success: false, error: '配置服务未初始化' }
    return ctx.getConfigService()!.unlock(password)
  })

  ipcMain.handle('auth:enableLock', async (_event, password: string) => {
    if (!ctx.getConfigService()) return { success: false, error: '配置服务未初始化' }
    return ctx.getConfigService()!.enableLock(password)
  })

  ipcMain.handle('auth:disableLock', async (_event, password: string) => {
    if (!ctx.getConfigService()) return { success: false, error: '配置服务未初始化' }
    return ctx.getConfigService()!.disableLock(password)
  })

  ipcMain.handle('auth:changePassword', async (_event, oldPassword: string, newPassword: string) => {
    if (!ctx.getConfigService()) return { success: false, error: '配置服务未初始化' }
    return ctx.getConfigService()!.changePassword(oldPassword, newPassword)
  })

  ipcMain.handle('auth:setHelloSecret', async (_event, password: string) => {
    if (!ctx.getConfigService()) return { success: false }
    ctx.getConfigService()!.setHelloSecret(password)
    return { success: true }
  })

  ipcMain.handle('auth:clearHelloSecret', async () => {
    if (!ctx.getConfigService()) return { success: false }
    ctx.getConfigService()!.clearHelloSecret()
    return { success: true }
  })

  ipcMain.handle('auth:isLockMode', async () => {
    return ctx.getConfigService()?.isLockMode() ?? false
  })
}
