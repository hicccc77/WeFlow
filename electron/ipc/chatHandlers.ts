import { app, ipcMain } from 'electron'
import { join } from 'path'
import { ConfigService } from '../services/config'
import { wcdbService } from '../services/wcdbService'
import { chatService } from '../services/chatService'
import { analyticsService } from '../services/analyticsService'
import { imageDecryptService } from '../services/imageDecryptService'
import {
  buildAccountNameMatcher,
  normalizeAccountId,
  removeMatchedEntriesInDir,
  removePathIfExists
} from '../utils/accountCleanupUtils'

export function registerChatHandlers(getConfigService: () => ConfigService | null) {
  // 聊天相关
  ipcMain.handle('chat:connect', async () => {
    return chatService.connect()
  })

  ipcMain.handle('chat:getSessions', async () => {
    return chatService.getSessions()
  })

  ipcMain.handle('chat:markAllSessionsRead', async () => {
    return chatService.markAllSessionsRead()
  })

  ipcMain.handle('chat:getSessionStatuses', async (_, usernames: string[]) => {
    return chatService.getSessionStatuses(usernames)
  })

  ipcMain.handle('chat:getExportTabCounts', async () => {
    return chatService.getExportTabCounts()
  })

  ipcMain.handle('chat:getContactTypeCounts', async () => {
    return chatService.getContactTypeCounts()
  })

  ipcMain.handle('chat:getSessionMessageCounts', async (_, sessionIds: string[]) => {
    return chatService.getSessionMessageCounts(sessionIds)
  })

  ipcMain.handle('chat:enrichSessionsContactInfo', async (_, usernames: string[], options?: {
    skipDisplayName?: boolean
    onlyMissingAvatar?: boolean
  }) => {
    return chatService.enrichSessionsContactInfo(usernames, options)
  })

  ipcMain.handle('chat:getMessages', async (_, sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) => {
    return chatService.getMessages(sessionId, offset, limit, startTime, endTime, ascending)
  })

  ipcMain.handle('chat:getLatestMessages', async (_, sessionId: string, limit?: number) => {
    return chatService.getLatestMessages(sessionId, limit)
  })

  ipcMain.handle('chat:getNewMessages', async (_, sessionId: string, minTime: number, limit?: number) => {
    return chatService.getNewMessages(sessionId, minTime, limit)
  })

  ipcMain.handle('chat:getAntiRevokeSessions', async () => {
    return chatService.getAntiRevokeSessions()
  })

  ipcMain.handle('chat:updateMessage', async (_, sessionId: string, localId: number, createTime: number, newContent: string) => {
    return chatService.updateMessage(sessionId, localId, createTime, newContent)
  })

  ipcMain.handle('chat:deleteMessage', async (_, sessionId: string, localId: number, createTime: number, dbPathHint?: string) => {
    return chatService.deleteMessage(sessionId, localId, createTime, dbPathHint)
  })

  ipcMain.handle('chat:checkAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.checkAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:installAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.installAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:uninstallAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.uninstallAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return await chatService.getContact(username)
  })


  ipcMain.handle('chat:getContactAvatar', async (_, username: string) => {
    return await chatService.getContactAvatar(username)
  })

  ipcMain.handle('chat:resolveTransferDisplayNames', async (_, chatroomId: string, payerUsername: string, receiverUsername: string) => {
    return await chatService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  })

  ipcMain.handle('chat:getContacts', async (_, options?: { lite?: boolean }) => {
    return await chatService.getContacts(options)
  })

  ipcMain.handle('chat:getCachedMessages', async (_, sessionId: string) => {
    return chatService.getCachedSessionMessages(sessionId)
  })

  ipcMain.handle('chat:getMyAvatarUrl', async () => {
    return chatService.getMyAvatarUrl()
  })

  ipcMain.handle('chat:downloadEmoji', async (_, cdnUrl: string, md5?: string) => {
    return chatService.downloadEmoji(cdnUrl, md5)
  })

  ipcMain.handle('chat:close', async () => {
    await chatService.close()
    return true
  })

  ipcMain.handle('chat:clearCurrentAccountData', async (_, options?: { clearCache?: boolean; clearExports?: boolean }) => {
    const cfg = getConfigService()
    if (!cfg) return { success: false, error: '配置服务未初始化' }

    const clearCache = options?.clearCache === true
    const clearExports = options?.clearExports === true
    if (!clearCache && !clearExports) {
      return { success: false, error: '请至少选择一项清理范围' }
    }

    const rawWxid = String(cfg.getMyWxidCleaned() || '').trim()
    if (!rawWxid) {
      return { success: false, error: '当前账号未登录或未识别，无法清理' }
    }
    const normalizedWxid = normalizeAccountId(rawWxid)
    const wxidCandidates = Array.from(new Set([rawWxid, normalizedWxid].filter(Boolean)))
    const isMatchedAccountName = buildAccountNameMatcher(wxidCandidates)
    const removedPaths: string[] = []
    const warnings: string[] = []

    try {
      await wcdbService.close()
      await chatService.close()
    } catch (error) {
      warnings.push(`关闭数据库连接失败: ${String(error)}`)
    }

    if (clearCache) {
      const [analyticsResult, imageResult] = await Promise.all([
        analyticsService.clearCache(),
        imageDecryptService.clearCache()
      ])
      const chatResult = await chatService.clearCaches()
      const cleanupResults = [analyticsResult, imageResult, chatResult]
      for (const result of cleanupResults) {
        if (!result.success && result.error) warnings.push(result.error)
      }

      const configuredCachePath = String(cfg.get('cachePath') || '').trim()
      const documentsWeFlowDir = join(app.getPath('documents'), 'WeFlow')
      const userDataCacheDir = join(app.getPath('userData'), 'cache')
      const cacheRootCandidates = [
        configuredCachePath,
        join(documentsWeFlowDir, 'Images'),
        join(documentsWeFlowDir, 'Voices'),
        join(documentsWeFlowDir, 'Emojis'),
        userDataCacheDir
      ].filter(Boolean)

      for (const wxid of wxidCandidates) {
        if (configuredCachePath) {
          await removePathIfExists(join(configuredCachePath, wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Images', wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Voices', wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Emojis', wxid), removedPaths, warnings)
        }
        await removePathIfExists(join(documentsWeFlowDir, 'Images', wxid), removedPaths, warnings)
        await removePathIfExists(join(documentsWeFlowDir, 'Voices', wxid), removedPaths, warnings)
        await removePathIfExists(join(documentsWeFlowDir, 'Emojis', wxid), removedPaths, warnings)
        await removePathIfExists(join(userDataCacheDir, wxid), removedPaths, warnings)
      }

      for (const cacheRoot of cacheRootCandidates) {
        await removeMatchedEntriesInDir(cacheRoot, isMatchedAccountName, removedPaths, warnings)
      }
    }

    if (clearExports) {
      const configuredExportPath = String(cfg.get('exportPath') || '').trim()
      const documentsWeFlowDir = join(app.getPath('documents'), 'WeFlow')
      const exportRootCandidates = [
        configuredExportPath,
        join(documentsWeFlowDir, 'exports'),
        join(documentsWeFlowDir, 'Exports')
      ].filter(Boolean)

      for (const exportRoot of exportRootCandidates) {
        await removeMatchedEntriesInDir(exportRoot, isMatchedAccountName, removedPaths, warnings)
      }

      const resetConfigKeys = [
        'exportSessionRecordMap',
        'exportLastSessionRunMap',
        'exportLastContentRunMap',
        'exportSessionMessageCountCacheMap',
        'exportSessionContentMetricCacheMap',
        'exportSnsStatsCacheMap',
        'snsPageCacheMap',
        'contactsListCacheMap',
        'contactsAvatarCacheMap',
        'lastSession'
      ]
      for (const key of resetConfigKeys) {
        const defaultValue = key === 'lastSession' ? '' : {}
        cfg.set(key as any, defaultValue as any)
      }

      try {
        const dbPath = String(cfg.get('dbPath') || '').trim()
        const automationMapRaw = cfg.get('exportAutomationTaskMap') as Record<string, unknown> | undefined
        if (automationMapRaw && typeof automationMapRaw === 'object') {
          const nextAutomationMap: Record<string, unknown> = { ...automationMapRaw }
          let changed = false
          for (const scopeKey of Object.keys(automationMapRaw)) {
            const normalizedScopeKey = String(scopeKey || '').trim()
            if (!normalizedScopeKey) continue
            const separatorIndex = normalizedScopeKey.lastIndexOf('::')
            const scopedDbPath = separatorIndex >= 0
              ? normalizedScopeKey.slice(0, separatorIndex)
              : ''
            const scopedWxidRaw = separatorIndex >= 0
              ? normalizedScopeKey.slice(separatorIndex + 2)
              : normalizedScopeKey
            const scopedWxid = normalizeAccountId(scopedWxidRaw)
            const wxidMatched = wxidCandidates.includes(scopedWxidRaw) || scopedWxid === normalizedWxid
            const dbPathMatched = !dbPath || !scopedDbPath || scopedDbPath === dbPath
            if (!wxidMatched || !dbPathMatched) continue
            delete nextAutomationMap[scopeKey]
            changed = true
          }
          if (changed) {
            cfg.set('exportAutomationTaskMap' as any, nextAutomationMap as any)
          } else if (!Object.keys(automationMapRaw).length) {
            cfg.set('exportAutomationTaskMap' as any, {} as any)
          }
        }
      } catch (error) {
        warnings.push(`清理自动化导出任务失败: ${String(error)}`)
      }
    }

    if (clearCache) {
      try {
        const wxidConfigsRaw = cfg.get('wxidConfigs') as Record<string, any> | undefined
        if (wxidConfigsRaw && typeof wxidConfigsRaw === 'object') {
          const nextConfigs: Record<string, any> = { ...wxidConfigsRaw }
          for (const key of Object.keys(nextConfigs)) {
            if (isMatchedAccountName(key) || normalizeAccountId(key) === normalizedWxid) {
              delete nextConfigs[key]
            }
          }
          cfg.set('wxidConfigs' as any, nextConfigs as any)
        }
        cfg.set('myWxid' as any, '')
        cfg.set('decryptKey' as any, '')
        cfg.set('imageXorKey' as any, 0)
        cfg.set('imageAesKey' as any, '')
        cfg.set('dbPath' as any, '')
        cfg.set('lastOpenedDb' as any, '')
        cfg.set('onboardingDone' as any, false)
        cfg.set('lastSession' as any, '')
      } catch (error) {
        warnings.push(`清理账号配置失败: ${String(error)}`)
      }
    }

    return {
      success: true,
      removedPaths,
      warning: warnings.length > 0 ? warnings.join('; ') : undefined
    }
  })

  ipcMain.handle('chat:getSessionDetail', async (_, sessionId: string) => {
    return chatService.getSessionDetail(sessionId)
  })

  ipcMain.handle('chat:getSessionDetailFast', async (_, sessionId: string) => {
    return chatService.getSessionDetailFast(sessionId)
  })

  ipcMain.handle('chat:getSessionDetailExtra', async (_, sessionId: string) => {
    return chatService.getSessionDetailExtra(sessionId)
  })

  ipcMain.handle('chat:getExportSessionStats', async (_, sessionIds: string[], options?: {
    includeRelations?: boolean
    forceRefresh?: boolean
    allowStaleCache?: boolean
    preferAccurateSpecialTypes?: boolean
    cacheOnly?: boolean
    beginTimestamp?: number
    endTimestamp?: number
  }) => {
    return chatService.getExportSessionStats(sessionIds, options)
  })

  ipcMain.handle('chat:getGroupMyMessageCountHint', async (_, chatroomId: string) => {
    return chatService.getGroupMyMessageCountHint(chatroomId)
  })

  ipcMain.handle('chat:getImageData', async (_, sessionId: string, msgId: string) => {
    return chatService.getImageData(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceData', async (_, sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => {
    return chatService.getVoiceData(sessionId, msgId, createTime, serverId)
  })
  ipcMain.handle('chat:getAllVoiceMessages', async (_, sessionId: string) => {
    return chatService.getAllVoiceMessages(sessionId)
  })
  ipcMain.handle('chat:getAllImageMessages', async (_, sessionId: string) => {
    return chatService.getAllImageMessages(sessionId)
  })
  ipcMain.handle('chat:getMessageDates', async (_, sessionId: string) => {
    return chatService.getMessageDates(sessionId)
  })
  ipcMain.handle('chat:getMessageDateCounts', async (_, sessionId: string) => {
    return chatService.getMessageDateCounts(sessionId)
  })

  ipcMain.handle('chat:getResourceMessages', async (_, options?: {
    sessionId?: string
    types?: Array<'image' | 'video' | 'voice' | 'file'>
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }) => {
    return chatService.getResourceMessages(options)
  })

  ipcMain.handle('chat:getMediaStream', async (_, options?: {
    sessionId?: string
    mediaType?: 'image' | 'video' | 'all'
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }) => {
    return wcdbService.getMediaStream(options)
  })
  ipcMain.handle('chat:resolveVoiceCache', async (_, sessionId: string, msgId: string) => {
    return chatService.resolveVoiceCache(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceTranscript', async (event, sessionId: string, msgId: string, createTime?: number) => {
    return chatService.getVoiceTranscript(sessionId, msgId, createTime, (text) => {
      event.sender.send('chat:voiceTranscriptPartial', { sessionId, msgId, createTime, text })
    })
  })

  ipcMain.handle('chat:getMessage', async (_, sessionId: string, localId: number) => {
    return chatService.getMessageById(sessionId, localId)
  })

  ipcMain.handle('chat:searchMessages', async (_, keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number) => {
    return chatService.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
  })

  ipcMain.handle('chat:getMyFootprintStats', async (_, beginTimestamp: number, endTimestamp: number, options?: {
    myWxid?: string
    privateSessionIds?: string[]
    groupSessionIds?: string[]
    mentionLimit?: number
    privateLimit?: number
    mentionMode?: 'text_at_me' | string
  }) => {
    return chatService.getMyFootprintStats(beginTimestamp, endTimestamp, options)
  })

  ipcMain.handle('chat:exportMyFootprint', async (_, beginTimestamp: number, endTimestamp: number, format: 'csv' | 'json', filePath: string) => {
    return chatService.exportMyFootprint(beginTimestamp, endTimestamp, format, filePath)
  })

}
