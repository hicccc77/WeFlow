import { ipcMain } from 'electron'
import { ConfigService } from '../services/config'
import { dbPathService } from '../services/dbPathService'
import { wcdbService } from '../services/wcdbService'
import { backupService } from '../services/backupService'

export function registerDatabaseHandlers(getConfigService: () => ConfigService | null) {
  // 数据库路径相关
  ipcMain.handle('dbpath:autoDetect', async () => {
    return dbPathService.autoDetect()
  })

  ipcMain.handle('dbpath:scanWxids', async (_, rootPath: string) => {
    return dbPathService.scanWxids(rootPath)
  })

  ipcMain.handle('dbpath:scanWxidCandidates', async (_, rootPath: string) => {
    return dbPathService.scanWxidCandidates(rootPath)
  })

  ipcMain.handle('dbpath:getDefault', async () => {
    return dbPathService.getDefaultPath()
  })

  // WCDB 数据库相关
  ipcMain.handle('wcdb:testConnection', async (_, dbPath: string, hexKey: string, wxid: string) => {
    const cfg = getConfigService() || new ConfigService()
    const accountDir = cfg.getAccountDir(dbPath, wxid)
    if (!accountDir) {
      return { success: false, error: '未找到账号目录' }
    }
    return wcdbService.testConnection(accountDir, hexKey)
  })

  ipcMain.handle('wcdb:open', async (_, dbPath: string, hexKey: string, wxid: string) => {
    const cfg = getConfigService() || new ConfigService()
    const accountDir = cfg.getAccountDir(dbPath, wxid)
    if (!accountDir) {
      return false
    }
    return wcdbService.open(accountDir, hexKey)
  })

  ipcMain.handle('wcdb:close', async () => {
    wcdbService.close()
    return true
  })

  ipcMain.handle('backup:create', async (_, payload: { outputPath: string; options?: { includeImages?: boolean; includeVideos?: boolean; includeFiles?: boolean } }) => {
    return backupService.createBackup(payload.outputPath, payload.options)
  })

  ipcMain.handle('backup:inspect', async (_, payload: { archivePath: string }) => {
    return backupService.inspectBackup(payload.archivePath)
  })

  ipcMain.handle('backup:restore', async (_, payload: { archivePath: string }) => {
    return backupService.restoreBackup(payload.archivePath)
  })



}
