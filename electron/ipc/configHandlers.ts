import { ipcMain } from 'electron'
import { messagePushService } from '../services/messagePushService'
import { insightService } from '../services/insightService'
import { insightRecordService } from '../services/insightRecordService'
import { normalizeWeiboCookieInput, weiboService } from '../services/social/weiboService'
import { MainIpcContext } from './mainIpcContext'

export function registerConfigHandlers(ctx: MainIpcContext) {
  ipcMain.handle('config:get', async (_, key: string) => {
    return ctx.getConfigService()?.get(key as any)
  })

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    let result: unknown
    if (key === 'launchAtStartup') {
      result = ctx.launchAtStartup.applyLaunchAtStartupPreference(value === true)
    } else {
      result = ctx.getConfigService()?.set(key as any, value)
    }
    if (key === 'updateChannel') {
      ctx.autoUpdate.applyAutoUpdateChannel('settings')
    }
    void messagePushService.handleConfigChanged(key)
    void insightService.handleConfigChanged(key)
    return result
  })

  ipcMain.handle('insight:testConnection', async () => {
    return insightService.testConnection()
  })

  ipcMain.handle('insight:getTodayStats', async () => {
    return insightService.getTodayStats()
  })

  ipcMain.handle('insight:listRecords', async (_, filters?: {
    keyword?: string
    sessionId?: string
    startTime?: number
    endTime?: number
    limit?: number
    offset?: number
  }) => {
    return insightRecordService.listRecords(filters || {})
  })

  ipcMain.handle('insight:getRecord', async (_, id: string) => {
    return insightRecordService.getRecord(id)
  })

  ipcMain.handle('insight:markRecordRead', async (_, id: string) => {
    return insightRecordService.markRecordRead(id)
  })

  ipcMain.handle('insight:clearRecords', async (_, filters?: {
    sessionId?: string
    startTime?: number
    endTime?: number
  }) => {
    return insightRecordService.clearRecords(filters || {})
  })

  ipcMain.handle('insight:triggerTest', async () => {
    return insightService.triggerTest()
  })

  ipcMain.handle('insight:generateFootprintInsight', async (_, payload: {
    rangeLabel: string
    summary: {
      private_inbound_people?: number
      private_replied_people?: number
      private_outbound_people?: number
      private_reply_rate?: number
      mention_count?: number
      mention_group_count?: number
    }
    privateSegments?: Array<{ displayName?: string; session_id?: string; incoming_count?: number; outgoing_count?: number; message_count?: number; replied?: boolean }>
    mentionGroups?: Array<{ displayName?: string; session_id?: string; count?: number }>
  }) => {
    return insightService.generateFootprintInsight(payload)
  })

  ipcMain.handle('social:saveWeiboCookie', async (_, rawInput: string) => {
    try {
      const configService = ctx.getConfigService()
      if (!configService) {
        return { success: false, error: 'Config service is not initialized' }
      }
      const normalized = normalizeWeiboCookieInput(rawInput)
      configService.set('aiInsightWeiboCookie' as any, normalized as any)
      weiboService.clearCache()
      return { success: true, normalized, hasCookie: Boolean(normalized) }
    } catch (error) {
      return { success: false, error: (error as Error).message || 'Failed to save Weibo cookie' }
    }
  })

  ipcMain.handle('social:validateWeiboUid', async (_, uid: string) => {
    try {
      const configService = ctx.getConfigService()
      if (!configService) {
        return { success: false, error: 'Config service is not initialized' }
      }
      const cookie = String(configService.get('aiInsightWeiboCookie' as any) || '')
      return await weiboService.validateUid(uid, cookie)
    } catch (error) {
      return { success: false, error: (error as Error).message || 'Failed to validate Weibo UID' }
    }
  })

  ipcMain.handle('config:clear', async () => {
    if (ctx.launchAtStartup.isLaunchAtStartupSupported() && ctx.launchAtStartup.getSystemLaunchAtStartup()) {
      const result = ctx.launchAtStartup.setSystemLaunchAtStartup(false)
      if (!result.success && result.error) {
        console.error('[WeFlow] 清空配置时关闭开机自启动失败:', result.error)
      }
    }
    ctx.getConfigService()?.clear()
    messagePushService.handleConfigCleared()
    insightService.handleConfigCleared()
    return true
  })
}
