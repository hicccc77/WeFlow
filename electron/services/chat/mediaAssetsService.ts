import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fsPromises } from 'fs'
import * as fs from 'fs'
import { app } from 'electron'
import { wcdbService } from '../wcdbService'
import { voiceTranscribeService } from '../voiceTranscribeService'
import { imageDecryptService } from '../imageDecryptService'
import { LRUCache } from '../../utils/LRUCache.js'
import { mapRowsToMessages } from './messageMapper'
import { parseImageInfo } from './messageParsing'
import { normalizeUnsignedIntegerToken } from './messageRowUtils'
import { loadSilkWasmModule, resolveSilkWasmFilePath } from '../silkWasmLoader'
import type { Message, ResourceMessageItem, ResourceMessageType } from './types'
import type { MediaAssetsHost } from './mediaAssetsHost'

export class MediaAssetsService {
  private voiceWavCache: LRUCache<string, Buffer>
  private voiceTranscriptCache: LRUCache<string, string>
  private voiceTranscriptPending = new Map<string, Promise<{ success: boolean; transcript?: string; error?: string }>>()
  private transcriptCacheLoaded = false
  private transcriptCacheDirty = false
  private transcriptFlushTimer: ReturnType<typeof setTimeout> | null = null
  private mediaDbsCache: string[] | null = null
  private mediaDbsCacheTime = 0
  private readonly mediaDbsCacheTtl = 300000
  private readonly voiceWavCacheMaxEntries = 50

  constructor(
    private readonly host: MediaAssetsHost,
    _cacheBasePath: string
  ) {
    this.voiceWavCache = new LRUCache(this.voiceWavCacheMaxEntries)
    this.voiceTranscriptCache = new LRUCache(1000)
  }

  clearVoiceCaches(): void {
    this.voiceWavCache.clear()
    this.voiceTranscriptCache.clear()
    this.voiceTranscriptPending.clear()
    this.transcriptCacheLoaded = false
    this.transcriptCacheDirty = false
    if (this.transcriptFlushTimer) {
      clearTimeout(this.transcriptFlushTimer)
      this.transcriptFlushTimer = null
    }
  }

  applyMediaDbList(paths: string[]): void {
    this.mediaDbsCache = [...paths]
    this.mediaDbsCacheTime = Date.now()
  }

  async warmupMediaDbsCache(): Promise<void> {
    try {
      const result = await wcdbService.listMediaDbs()
      if (result.success && result.data) {
        this.mediaDbsCache = result.data as string[]
        this.mediaDbsCacheTime = Date.now()
      }
    } catch (e) {
      // 静默失败，不影响主流程
    }
  }
  private getVoiceLookupCandidates(sessionId: string, msg: Message): string[] {
    const candidates: string[] = []
    const add = (value?: string | null) => {
      const trimmed = value?.trim()
      if (!trimmed) return
      if (!candidates.includes(trimmed)) candidates.push(trimmed)
    }
    add(sessionId)
    add(msg.senderUsername)
    add(this.host.getMyWxidCleaned())
    return candidates
  }

  private decodeVoiceBlob(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
          return Buffer.from(trimmed, 'hex')
        } catch { }
      }
      try {
        return Buffer.from(trimmed, 'base64')
      } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }
  private getVoiceCacheDir(): string {
    const cachePath = this.host.getConfigString('cachePath')
    if (cachePath) {
      return join(cachePath, 'Voices')
    }
    // 回退到默认目录
    const documentsPath = app.getPath('documents')
    return join(documentsPath, 'WeFlow', 'Voices')
  }
  async getImageData(sessionId: string, msgId: string): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const localId = parseInt(msgId, 10)
      if (!this.host.isConnected()) {
        const connectResult = await this.host.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error || '数据库未连接' }
        }
      }

      // 1. 获取消息详情
      const msgResult = await this.host.getMessageByLocalId(sessionId, localId)
      if (!msgResult.success || !msgResult.message) {
        return { success: false, error: '未找到消息' }
      }
      const msg = msgResult.message
      const rawImageInfo = msg.rawContent ? parseImageInfo(msg.rawContent) : {}
      const imageMd5 = msg.imageMd5 || rawImageInfo.md5
      const imageOriginSourceMd5 = msg.imageOriginSourceMd5 || rawImageInfo.originSourceMd5
      const imageDatName = msg.imageDatName

      if (!imageMd5 && !imageOriginSourceMd5 && !imageDatName) {
        return { success: false, error: '图片缺少 md5/datName，无法定位原文件' }
      }

      // 2. 使用 imageDecryptService 解密图片（仅使用真实图片标识）
      const result = await imageDecryptService.decryptImage({
        sessionId,
        imageMd5,
        imageOriginSourceMd5,
        imageDatName,
        createTime: msg.createTime,
        force: false,
        preferFilePath: true,
        hardlinkOnly: true
      })

      if (!result.success || !result.localPath) {
        return { success: false, error: result.error || '图片解密失败' }
      }

      // 3. 读取解密后的文件并转成 base64
      // 如果已经是 data URL，直接返回 base64 部分
      if (result.localPath.startsWith('data:')) {
        const base64Data = result.localPath.split(',')[1]
        return { success: true, data: base64Data }
      }

      // localPath 是 file:// URL，需要转换成文件路径
      const filePath = result.localPath.startsWith('file://')
        ? result.localPath.replace(/^file:\/\//, '')
        : result.localPath

      const imageData = readFileSync(filePath)
      return { success: true, data: imageData.toString('base64') }
    } catch (e) {
      console.error('ChatService: getImageData 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * getVoiceData（主用批量专属接口读取语音数据）
   */
  async getVoiceData(sessionId: string, msgId: string, createTime?: number, serverId?: string | number, senderWxidOpt?: string): Promise<{ success: boolean; data?: string; error?: string }> {
    const startTime = Date.now()
    const verboseVoiceTrace = process.env.WEFLOW_VOICE_TRACE === '1'
    const msgCreateTimeLabel = (value?: number): string => {
      return Number.isFinite(Number(value)) ? String(Math.floor(Number(value))) : '无'
    }
    const lookupPath: string[] = []
    const logLookupPath = (status: 'success' | 'fail', error?: string): void => {
      const timeline = lookupPath.map((step, idx) => `${idx + 1}.${step}`).join(' -> ')
      if (status === 'success') {
        if (verboseVoiceTrace) {
          console.info(`[Voice] 定位流程成功: ${timeline}`)
        }
      } else {
        console.warn(`[Voice] 定位流程失败${error ? `(${error})` : ''}: ${timeline}`)
      }
    }

    try {
      lookupPath.push(`会话=${sessionId}, 消息=${msgId}, 传入createTime=${msgCreateTimeLabel(createTime)}, serverId=${String(serverId || 0)}`)
      lookupPath.push(`消息来源提示=${senderWxidOpt || '无'}`)

      const localId = parseInt(msgId, 10)
      if (isNaN(localId)) {
        logLookupPath('fail', '无效的消息ID')
        return { success: false, error: '无效的消息ID' }
      }

      let msgCreateTime = createTime
      let senderWxid: string | null = senderWxidOpt || null
      let resolvedServerId: string | number = normalizeUnsignedIntegerToken(serverId) || 0
      let locatedMsg: Message | null = null
      let rejectedNonVoiceLookup = false

      lookupPath.push(`初始解析localId=${localId}成功`)

      // 已提供强键(createTime + serverId)时，直接走语音定位，避免 localId 反查噪音与误导
      const hasStrongInput = Number.isFinite(Number(msgCreateTime)) && Number(msgCreateTime) > 0
        && Boolean(normalizeUnsignedIntegerToken(serverId))

      if (hasStrongInput) {
        lookupPath.push('调用入参已具备强键(createTime+serverId)，跳过localId反查')
      } else {
        const t1 = Date.now()
        const msgResult = await this.host.getMessageByLocalId(sessionId, localId)
        const t2 = Date.now()
        lookupPath.push(`消息反查耗时=${t2 - t1}ms`)
        if (!msgResult.success || !msgResult.message) {
          lookupPath.push('未命中: getMessageByLocalId')
        } else {
          const dbMsg = msgResult.message as Message
          const locatedServerId = normalizeUnsignedIntegerToken(dbMsg.serverIdRaw ?? dbMsg.serverId)
          const incomingServerId = normalizeUnsignedIntegerToken(serverId)
          lookupPath.push(`命中消息定位: localId=${dbMsg.localId}, createTime=${dbMsg.createTime}, sender=${dbMsg.senderUsername || ''}, serverId=${locatedServerId || '0'}, localType=${dbMsg.localType}, voice时长=${dbMsg.voiceDurationSeconds ?? 0}`)

          if (incomingServerId && locatedServerId && incomingServerId !== locatedServerId) {
            lookupPath.push(`serverId纠正: input=${incomingServerId}, db=${locatedServerId}`)
          }

          // localId 在不同表可能重复，反查命中非语音时不覆盖调用侧入参
          if (Number(dbMsg.localType) === 34) {
            locatedMsg = dbMsg
            msgCreateTime = dbMsg.createTime || msgCreateTime
            senderWxid = dbMsg.senderUsername || senderWxid || null
            if (locatedServerId) {
              resolvedServerId = locatedServerId
            }
          } else {
            rejectedNonVoiceLookup = true
            lookupPath.push('消息反查命中但localType!=34，忽略反查覆盖，继续使用调用入参定位')
          }
        }
      }

      if (!msgCreateTime) {
        lookupPath.push('定位失败: 未找到消息时间戳')
        logLookupPath('fail', '未找到消息时间戳')
        return { success: false, error: '未找到消息时间戳' }
      }
      if (!locatedMsg) {
        lookupPath.push(rejectedNonVoiceLookup
          ? `定位结果: 反查命中非语音并已忽略, createTime=${msgCreateTime}, sender=${senderWxid || '无'}`
          : `定位结果: 未走消息反查流程, createTime=${msgCreateTime}, sender=${senderWxid || '无'}`)
      } else {
        lookupPath.push(`定位结果: 语音消息被确认 localId=${localId}, createTime=${msgCreateTime}, sender=${senderWxid || '无'}`)
      }
      lookupPath.push(`最终serverId=${String(resolvedServerId || 0)}`)

      if (verboseVoiceTrace) {
        if (locatedMsg) {
          console.log('[Voice] 定位到的具体语音消息:', {
            sessionId,
            msgId,
            localId: locatedMsg.localId,
            createTime: locatedMsg.createTime,
            senderUsername: locatedMsg.senderUsername,
            serverId: locatedMsg.serverIdRaw || locatedMsg.serverId,
            localType: locatedMsg.localType,
            voiceDurationSeconds: locatedMsg.voiceDurationSeconds
          })
        } else {
          console.log('[Voice] 定位到的语音消息:', {
            sessionId,
            msgId,
            localId,
            createTime: msgCreateTime,
            senderUsername: senderWxid,
            serverId: resolvedServerId
          })
        }
      }

      // 使用 sessionId + createTime + msgId 作为缓存 key，避免同秒语音串音
      const cacheKey = this.getVoiceCacheKey(sessionId, String(localId), msgCreateTime)

      // 检查 WAV 内存缓存
      const wavCache = this.voiceWavCache.get(cacheKey)
      if (wavCache) {
        lookupPath.push('命中内存WAV缓存')
        logLookupPath('success', '内存缓存')
        return { success: true, data: wavCache.toString('base64') }
      }

      // 检查 WAV 文件缓存
      const voiceCacheDir = this.getVoiceCacheDir()
      const wavFilePath = join(voiceCacheDir, `${cacheKey}.wav`)
      if (existsSync(wavFilePath)) {
        try {
          const wavData = readFileSync(wavFilePath)
          this.cacheVoiceWav(cacheKey, wavData)
          lookupPath.push('命中磁盘WAV缓存')
          logLookupPath('success', '磁盘缓存')
          return { success: true, data: wavData.toString('base64') }
        } catch (e) {
          lookupPath.push('命中磁盘WAV缓存但读取失败')
          console.error('[Voice] 读取缓存文件失败:', e)
        }
      }
      lookupPath.push('缓存未命中，进入DB定位')

      // 构建查找候选
      const candidates: string[] = []
      const myWxid = this.host.getMyWxidCleaned() as string

      // 如果有 senderWxid，优先使用（群聊中最重要）
      if (senderWxid) {
        candidates.push(senderWxid)
      }

      // sessionId（1对1聊天时是对方wxid，群聊时是群id）
      if (sessionId && !candidates.includes(sessionId)) {
        candidates.push(sessionId)
      }

      // 我的wxid（兜底）
      if (myWxid && !candidates.includes(myWxid)) {
        candidates.push(myWxid)
      }
      lookupPath.push(`定位候选链=${JSON.stringify(candidates)}`)

      const t3 = Date.now()
      // 从数据库读取 silk 数据
      const silkData = await this.getVoiceDataFromMediaDb(sessionId, msgCreateTime, localId, resolvedServerId || 0, candidates, lookupPath, myWxid)
      const t4 = Date.now()
      lookupPath.push(`DB定位耗时=${t4 - t3}ms`)


      if (!silkData) {
        logLookupPath('fail', '未找到语音数据')
        return { success: false, error: '未找到语音数据 (请确保已在微信中播放过该语音)' }
      }
      lookupPath.push('语音二进制定位完成')

      const t5 = Date.now()
      // 使用 silk-wasm 解码
      const pcmData = await this.decodeSilkToPcm(silkData, 24000)
      const t6 = Date.now()
      lookupPath.push(`silk解码耗时=${t6 - t5}ms`)


      if (!pcmData) {
        logLookupPath('fail', 'Silk解码失败')
        return { success: false, error: 'Silk 解码失败' }
      }
      lookupPath.push('silk解码成功')

      const t7 = Date.now()
      // PCM -> WAV
      const wavData = this.createWavBuffer(pcmData, 24000)
      const t8 = Date.now()
      lookupPath.push(`WAV转码耗时=${t8 - t7}ms`)


      // 缓存 WAV 数据到内存
      this.cacheVoiceWav(cacheKey, wavData)

      // 缓存 WAV 数据到文件（异步，不阻塞返回）
      this.cacheVoiceWavToFile(cacheKey, wavData)

      lookupPath.push(`总耗时=${t8 - startTime}ms`)
      logLookupPath('success')

      return { success: true, data: wavData.toString('base64') }
    } catch (e) {
      lookupPath.push(`异常: ${String(e)}`)
      logLookupPath('fail', String(e))
      console.error('ChatService: getVoiceData 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 缓存 WAV 数据到文件（异步）
   */
  private async cacheVoiceWavToFile(cacheKey: string, wavData: Buffer): Promise<void> {
    try {
      const voiceCacheDir = this.getVoiceCacheDir()
      await fsPromises.mkdir(voiceCacheDir, { recursive: true })
      const wavFilePath = join(voiceCacheDir, `${cacheKey}.wav`)
      await fsPromises.writeFile(wavFilePath, wavData)
    } catch (e) {
      console.error('[Voice] 缓存文件失败:', e)
    }
  }

  /**
   * 通过 WCDB 专属接口查询语音数据
   * 策略：批量查询 + 单条 native 兜底
   */
  private async getVoiceDataFromMediaDb(
    sessionId: string,
    createTime: number,
    localId: number,
    svrId: string | number,
    candidates: string[],
    lookupPath?: string[],
    myWxid?: string
  ): Promise<Buffer | null> {
    try {
      const candidatesList = Array.isArray(candidates)
        ? candidates.filter((value, index, arr) => {
          const key = String(value || '').trim()
          return Boolean(key) && arr.findIndex(v => String(v || '').trim() === key) === index
        })
        : []
      const createTimeInt = Math.max(0, Math.floor(Number(createTime || 0)))
      const localIdInt = Math.max(0, Math.floor(Number(localId || 0)))
      const svrIdToken = svrId || 0

      const plans: Array<{ label: string; list: string[] }> = []
      if (candidatesList.length > 0) {
        const strict = String(myWxid || '').trim()
          ? candidatesList.filter(item => item !== String(myWxid || '').trim())
          : candidatesList.slice()
        if (strict.length > 0 && strict.length !== candidatesList.length) {
          plans.push({ label: 'strict(no-self)', list: strict })
        }
        plans.push({ label: 'full', list: candidatesList })
      } else {
        plans.push({ label: 'empty', list: [] })
      }

      lookupPath?.push(`构建音频查询参数 createTime=${createTimeInt}, localId=${localIdInt}, svrId=${svrIdToken}, plans=${plans.map(p => `${p.label}:${p.list.length}`).join('|')}`)

      for (const plan of plans) {
        lookupPath?.push(`尝试候选集[${plan.label}]=${JSON.stringify(plan.list)}`)
        // 先走单条 native：svr_id 通过 int64 直传，避免 batch JSON 的大整数精度/解析差异
        lookupPath?.push(`先尝试单条查询(${plan.label})`)
        const single = await wcdbService.getVoiceData(
          sessionId,
          createTimeInt,
          plan.list,
          localIdInt,
          svrIdToken
        )
        lookupPath?.push(`单条查询(${plan.label})结果: success=${single.success}, hasHex=${Boolean(single.hex)}`)
        if (single.success && single.hex) {
          const decoded = this.decodeVoiceBlob(single.hex)
          if (decoded && decoded.length > 0) {
            lookupPath?.push(`单条查询(${plan.label})解码成功`)
            return decoded
          }
          lookupPath?.push(`单条查询(${plan.label})解码为空`)
        }

        const batchResult = await wcdbService.getVoiceDataBatch([{
          session_id: sessionId,
          create_time: createTimeInt,
          local_id: localIdInt,
          svr_id: svrIdToken,
          candidates: plan.list
        }])
        lookupPath?.push(`批量查询(${plan.label})结果: success=${batchResult.success}, rows=${Array.isArray(batchResult.rows) ? batchResult.rows.length : 0}`)
        if (!batchResult.success) {
          lookupPath?.push(`批量查询(${plan.label})失败: ${batchResult.error || '无错误信息'}`)
        }

        if (batchResult.success && Array.isArray(batchResult.rows) && batchResult.rows.length > 0) {
          const hex = String(batchResult.rows[0]?.hex || '').trim()
          lookupPath?.push(`命中批量结果(${plan.label})[0], hexLen=${hex.length}`)
          if (hex) {
            const decoded = this.decodeVoiceBlob(hex)
            if (decoded && decoded.length > 0) {
              lookupPath?.push(`批量结果(${plan.label})解码成功`)
              return decoded
            }
            lookupPath?.push(`批量结果(${plan.label})解码为空`)
          }
        } else {
          lookupPath?.push(`批量结果(${plan.label})未命中`)
        }
      }

      lookupPath?.push('音频定位失败：未命中任何结果')
      return null
    } catch (e) {
      lookupPath?.push(`音频定位异常: ${String(e)}`)
      return null
    }
  }

  async preloadVoiceDataBatch(
    sessionId: string,
    messages: Array<{
      localId?: number | string
      createTime?: number | string
      serverId?: number | string
      senderWxid?: string | null
    }>,
    options?: { chunkSize?: number; decodeConcurrency?: number }
  ): Promise<{ success: boolean; prepared?: number; error?: string }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const normalizedSessionId = String(sessionId || '').trim()
      if (!normalizedSessionId) return { success: true, prepared: 0 }
      if (!Array.isArray(messages) || messages.length === 0) return { success: true, prepared: 0 }

      const myWxid = String(this.host.getMyWxidCleaned() || '').trim()
      const nowPrepared = new Set<string>()
      const pending: Array<{
        cacheKey: string
        request: { session_id: string; create_time: number; local_id: number; svr_id: string | number; candidates: string[] }
      }> = []

      for (const item of messages) {
        const localId = Math.max(0, Math.floor(Number(item?.localId || 0)))
        const createTime = Math.max(0, Math.floor(Number(item?.createTime || 0)))
        if (!localId || !createTime) continue

        const cacheKey = this.getVoiceCacheKey(normalizedSessionId, String(localId), createTime)
        if (nowPrepared.has(cacheKey)) continue
        nowPrepared.add(cacheKey)

        const inMemory = this.voiceWavCache.get(cacheKey)
        if (inMemory && inMemory.length > 0) continue

        const wavFilePath = join(this.getVoiceCacheDir(), `${cacheKey}.wav`)
        if (existsSync(wavFilePath)) {
          try {
            const wavData = readFileSync(wavFilePath)
            if (wavData.length > 0) {
              this.cacheVoiceWav(cacheKey, wavData)
              continue
            }
          } catch {
            // ignore corrupted cache file
          }
        }

        const senderWxid = String(item?.senderWxid || '').trim()
        const candidates: string[] = []
        if (senderWxid) candidates.push(senderWxid)
        if (!candidates.includes(normalizedSessionId)) candidates.push(normalizedSessionId)
        if (myWxid && !candidates.includes(myWxid)) candidates.push(myWxid)

        pending.push({
          cacheKey,
          request: {
            session_id: normalizedSessionId,
            create_time: createTime,
            local_id: localId,
            svr_id: item?.serverId || 0,
            candidates
          }
        })
      }

      if (pending.length === 0) {
        return { success: true, prepared: nowPrepared.size }
      }

      const chunkSize = Math.max(8, Math.min(128, Math.floor(Number(options?.chunkSize || 48))))
      const decodeConcurrency = Math.max(1, Math.min(6, Math.floor(Number(options?.decodeConcurrency || 3))))
      let prepared = nowPrepared.size - pending.length

      for (let i = 0; i < pending.length; i += chunkSize) {
        const chunk = pending.slice(i, i + chunkSize)
        const batchResult = await wcdbService.getVoiceDataBatch(chunk.map(item => item.request))
        if (!batchResult.success || !Array.isArray(batchResult.rows)) {
          continue
        }

        const byIndex = new Map<number, string>()
        for (const row of batchResult.rows as Array<Record<string, any>>) {
          const idx = Number.parseInt(String(row?.index ?? ''), 10)
          const hex = String(row?.hex || '').trim()
          if (!Number.isFinite(idx) || idx < 0 || !hex) continue
          byIndex.set(idx, hex)
        }

        const readyItems: Array<{ cacheKey: string; hex: string }> = []
        for (let rowIdx = 0; rowIdx < chunk.length; rowIdx += 1) {
          const hex = byIndex.get(rowIdx)
          if (!hex) continue
          readyItems.push({ cacheKey: chunk[rowIdx].cacheKey, hex })
        }

        await this.host.forEachWithConcurrency(readyItems, decodeConcurrency, async (item) => {
          const silkData = this.decodeVoiceBlob(item.hex)
          if (!silkData || silkData.length === 0) return

          const pcmData = await this.decodeSilkToPcm(silkData, 24000)
          if (!pcmData || pcmData.length === 0) return

          const wavData = this.createWavBuffer(pcmData, 24000)
          this.cacheVoiceWav(item.cacheKey, wavData)
          this.cacheVoiceWavToFile(item.cacheKey, wavData)
          prepared += 1
        })
      }

      return { success: true, prepared }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 检查语音是否已有缓存（只检查内存，不查询数据库）
   */
  async resolveVoiceCache(sessionId: string, msgId: string): Promise<{ success: boolean; hasCache: boolean; data?: string }> {
    try {
      // 直接用 msgId 生成 cacheKey，不查询数据库
      // 注意：这里的 cacheKey 可能不准确（因为没有 createTime），但只是用来快速检查缓存
      // 如果缓存未命中，用户点击时会重新用正确的 cacheKey 查询
      const cacheKey = this.getVoiceCacheKey(sessionId, msgId)

      // 检查内存缓存
      const inMemory = this.voiceWavCache.get(cacheKey)
      if (inMemory) {
        return { success: true, hasCache: true, data: inMemory.toString('base64') }
      }

      return { success: true, hasCache: false }
    } catch (e) {
      return { success: false, hasCache: false }
    }
  }

  async getVoiceData_Legacy(sessionId: string, msgId: string): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const localId = parseInt(msgId, 10)
      const msgResult = await this.host.getMessageByLocalId(sessionId, localId)
      if (!msgResult.success || !msgResult.message) return { success: false, error: '未找到该消息' }
      const msg = msgResult.message
      const senderWxid = msg.senderUsername || undefined
      return this.getVoiceData(sessionId, msgId, msg.createTime, msg.serverIdRaw || msg.serverId, senderWxid)
    } catch (e) {
      console.error('ChatService: getVoiceData 失败:', e)
      return { success: false, error: String(e) }
    }
  }



  /**
   * 解码 Silk 数据为 PCM (silk-wasm)
   */
  private async decodeSilkToPcm(silkData: Buffer, sampleRate: number): Promise<Buffer | null> {
    try {
      let wasmPath = resolveSilkWasmFilePath()
      if (!wasmPath && app.isPackaged) {
        const candidates = [
          join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'silk-wasm', 'lib', 'silk.wasm'),
          join(process.resourcesPath, 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
        ]
        wasmPath = candidates.find((path) => existsSync(path)) || null
      }
      if (!wasmPath) {
        wasmPath = join(app.getAppPath(), 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
      }

      if (!wasmPath || !existsSync(wasmPath)) {
        console.error('[ChatService][Voice] silk.wasm not found at:', wasmPath)
        return null
      }

      const silkWasm = loadSilkWasmModule()
      if (!silkWasm || !silkWasm.decode) {
        console.error('[ChatService][Voice] silk-wasm module invalid')
        return null
      }

      const result = await silkWasm.decode(silkData, sampleRate)
      return Buffer.from(result.data)
    } catch (e) {
      console.error('[ChatService][Voice] internal decode error:', e)
      return null
    }
  }

  /**
   * 创建 WAV 文件 Buffer
   */
  private createWavBuffer(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
    const pcmLength = pcmData.length
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * channels * 2, 28)
    header.writeUInt16LE(channels * 2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)
    return Buffer.concat([header, pcmData])
  }

  async getVoiceTranscript(
    sessionId: string,
    msgId: string,
    createTime?: number,
    onPartial?: (text: string) => void,
    senderWxid?: string
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    const startTime = Date.now()

    // 确保磁盘缓存已加载
    this.loadTranscriptCacheIfNeeded()

    try {
      let msgCreateTime = createTime
      let serverId: string | number | undefined

      // 如果前端没传 createTime，才需要查询消息（这个很慢）
      if (!msgCreateTime) {
        const t1 = Date.now()
        const msgResult = await this.host.getMessageByLocalId(sessionId, parseInt(msgId, 10))
        const t2 = Date.now()


        if (msgResult.success && msgResult.message) {
          msgCreateTime = msgResult.message.createTime
          serverId = msgResult.message.serverIdRaw || msgResult.message.serverId

        }
      }

      if (!msgCreateTime) {
        console.error(`[Transcribe] 未找到消息时间戳`)
        return { success: false, error: '未找到消息时间戳' }
      }

      // 使用正确的 cacheKey（包含 createTime）
      const cacheKey = this.getVoiceCacheKey(sessionId, msgId, msgCreateTime)


      // 检查转写缓存
      const cached = this.voiceTranscriptCache.get(cacheKey)
      if (cached) {

        return { success: true, transcript: cached }
      }

      // 检查是否正在转写
      const pending = this.voiceTranscriptPending.get(cacheKey)
      if (pending) {

        return pending
      }

      const task = (async () => {
        try {
          // 检查内存中是否有 WAV 数据
          let wavData = this.voiceWavCache.get(cacheKey)
          if (wavData) {

          } else {
            // 检查文件缓存
            const voiceCacheDir = this.getVoiceCacheDir()
            const wavFilePath = join(voiceCacheDir, `${cacheKey}.wav`)
            if (existsSync(wavFilePath)) {
              try {
                wavData = readFileSync(wavFilePath)

                // 同时缓存到内存
                this.cacheVoiceWav(cacheKey, wavData)
              } catch (e) {
                console.error(`[Transcribe] 读取缓存文件失败:`, e)
              }
            }
          }

          if (!wavData) {

            const t3 = Date.now()
            // 调用 getVoiceData 获取并解码
            const voiceResult = await this.getVoiceData(sessionId, msgId, msgCreateTime, serverId, senderWxid)
            const t4 = Date.now()


            if (!voiceResult.success || !voiceResult.data) {
              console.error(`[Transcribe] 语音解码失败: ${voiceResult.error}`)
              return { success: false, error: voiceResult.error || '语音解码失败' }
            }
            wavData = Buffer.from(voiceResult.data, 'base64')

          }

          // 转写

          const t5 = Date.now()
          const result = await voiceTranscribeService.transcribeWavBuffer(wavData, (text) => {

            onPartial?.(text)
          })
          const t6 = Date.now()


          if (result.success && result.transcript) {

            this.cacheVoiceTranscript(cacheKey, result.transcript)
          } else {
            console.error(`[Transcribe] 转写失败: ${result.error}`)
          }


          return result
        } catch (error) {
          console.error(`[Transcribe] 异常:`, error)
          return { success: false, error: String(error) }
        } finally {
          this.voiceTranscriptPending.delete(cacheKey)
        }
      })()

      this.voiceTranscriptPending.set(cacheKey, task)
      return task
    } catch (error) {
      console.error(`[Transcribe] 外层异常:`, error)
      return { success: false, error: String(error) }
    }
  }



  private getVoiceCacheKey(sessionId: string, msgId: string, createTime?: number): string {
    // createTime + msgId 可避免同会话同秒多条语音互相覆盖
    if (createTime) {
      return `${sessionId}_${createTime}_${msgId}`
    }
    return `${sessionId}_${msgId}`
  }

  private cacheVoiceWav(cacheKey: string, wavData: Buffer): void {
    this.voiceWavCache.set(cacheKey, wavData)
    // LRU缓存会自动处理大小限制，无需手动清理
  }

  /** 获取持久化转写缓存文件路径 */
  private getTranscriptCachePath(): string {
    const cachePath = this.host.getConfigString('cachePath')
    const base = cachePath || join(app.getPath('documents'), 'WeFlow')
    return join(base, 'Voices', 'transcripts.json')
  }

  /** 首次访问时从磁盘加载转写缓存 */
  private loadTranscriptCacheIfNeeded(): void {
    if (this.transcriptCacheLoaded) return
    this.transcriptCacheLoaded = true
    try {
      const filePath = this.getTranscriptCachePath()
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8')
        const data = JSON.parse(raw) as Record<string, string>
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'string') this.voiceTranscriptCache.set(k, v)
        }
        console.log(`[Transcribe] 从磁盘加载了 ${this.voiceTranscriptCache.size} 条转写缓存`)
      }
    } catch (e) {
      console.error('[Transcribe] 加载转写缓存失败:', e)
    }
  }

  /** 将转写缓存持久化到磁盘（防抖 3 秒） */
  private scheduleTranscriptFlush(): void {
    if (this.transcriptFlushTimer) return
    this.transcriptFlushTimer = setTimeout(() => {
      this.transcriptFlushTimer = null
      this.flushTranscriptCache()
    }, 3000)
  }

  /** 立即写入转写缓存到磁盘 */
  flushTranscriptCache(): void {
    if (!this.transcriptCacheDirty) return
    try {
      const filePath = this.getTranscriptCachePath()
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const obj: Record<string, string> = {}
      for (const [k, v] of this.voiceTranscriptCache) obj[k] = v
      writeFileSync(filePath, JSON.stringify(obj), 'utf-8')
      this.transcriptCacheDirty = false
    } catch (e) {
      console.error('[Transcribe] 写入转写缓存失败:', e)
    }
  }

  private cacheVoiceTranscript(cacheKey: string, transcript: string): void {
    this.voiceTranscriptCache.set(cacheKey, transcript)
    this.transcriptCacheDirty = true
    this.scheduleTranscriptFlush()
  }

  /**
   * 检查某个语音消息是否已有缓存的转写结果
   */
  hasTranscriptCache(sessionId: string, msgId: string, createTime?: number): boolean {
    this.loadTranscriptCacheIfNeeded()
    const cacheKey = this.getVoiceCacheKey(sessionId, msgId, createTime)
    return this.voiceTranscriptCache.has(cacheKey)
  }

  /**
   * 批量统计转写缓存命中数（按会话维度）。
   * 仅基于本地 transcripts cache key 统计，用于导出前快速预估。
   */
  getCachedVoiceTranscriptCountMap(sessionIds: string[]): Record<string, number> {
    this.loadTranscriptCacheIfNeeded()
    const normalizedIds = Array.from(
      new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))
    )
    const targetSet = new Set(normalizedIds)
    const countMap: Record<string, number> = {}
    for (const sessionId of normalizedIds) {
      countMap[sessionId] = 0
    }
    if (targetSet.size === 0) return countMap

    for (const key of this.voiceTranscriptCache.keys()) {
      const rawKey = String(key || '')
      if (!rawKey) continue
      // 新 key: `${sessionId}_${createTime}_${msgId}`；旧 key: `${sessionId}_${createTime}`
      const matchNew = /^(.*)_(\d+)_(\d+)$/.exec(rawKey)
      const matchOld = matchNew ? null : /^(.*)_(\d+)$/.exec(rawKey)
      const sessionId = String((matchNew ? matchNew[1] : (matchOld ? matchOld[1] : '')) || '').trim()
      if (!sessionId || !targetSet.has(sessionId)) continue
      countMap[sessionId] = (countMap[sessionId] || 0) + 1
    }

    return countMap
  }

  /**
   * 获取某会话的所有语音消息（localType=34），用于批量转写
   */
  async getAllVoiceMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const result = await wcdbService.getMessagesByType(sessionId, 34, false, 0, 0)
      if (!result.success || !Array.isArray(result.rows)) {
        return { success: false, error: result.error || '查询语音消息失败' }
      }

      let allVoiceMessages: Message[] = mapRowsToMessages(result.rows as Record<string, any>[], sessionId, String(this.host.getMyWxidCleaned() || '').trim())

      // 按 createTime 降序排序
      allVoiceMessages.sort((a, b) => b.createTime - a.createTime)

      // 去重
      const seen = new Set<string>()
      allVoiceMessages = allVoiceMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      this.host.chatServiceLog(`共找到 ${allVoiceMessages.length} 条语音消息（去重后）`)
      return { success: true, messages: allVoiceMessages }
    } catch (e) {
      console.error('[ChatService] 获取所有语音消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取某会话中有消息的日期列表
   * 返回 YYYY-MM-DD 格式的日期字符串数组
   */
  /**
   * 获取某会话的全部图片消息（用于聊天页批量图片解密）
   */
  async getAllImageMessages(
    sessionId: string
  ): Promise<{ success: boolean; images?: { imageMd5?: string; imageOriginSourceMd5?: string; imageDatName?: string; createTime?: number }[]; error?: string }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const result = await wcdbService.getMessagesByType(sessionId, 3, false, 0, 0)
      if (!result.success || !Array.isArray(result.rows)) {
        return { success: false, error: result.error || '查询图片消息失败' }
      }

      const mapped = mapRowsToMessages(result.rows as Record<string, any>[], sessionId, String(this.host.getMyWxidCleaned() || '').trim())
      let allImages: Array<{ imageMd5?: string; imageOriginSourceMd5?: string; imageDatName?: string; createTime?: number }> = mapped
        .filter(msg => msg.localType === 3)
        .map(msg => ({
          imageMd5: msg.imageMd5 || undefined,
          imageOriginSourceMd5: msg.imageOriginSourceMd5 || undefined,
          imageDatName: msg.imageDatName || undefined,
          createTime: msg.createTime || undefined
        }))
        .filter(img => Boolean(img.imageMd5 || img.imageOriginSourceMd5 || img.imageDatName))

      allImages.sort((a, b) => (b.createTime || 0) - (a.createTime || 0))

      const seen = new Set<string>()
      allImages = allImages.filter(img => {
        const key = img.imageMd5 || img.imageOriginSourceMd5 || img.imageDatName || ''
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })

      this.host.chatServiceLog(`共找到 ${allImages.length} 条图片消息（去重后）`)
      return { success: true, images: allImages }
    } catch (e) {
      console.error('[ChatService] 获取全部图片消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private resolveResourceType(message: Message): ResourceMessageType | null {
    if (message.localType === 3) return 'image'
    if (message.localType === 43) return 'video'
    if (message.localType === 34) return 'voice'
    if (
      message.localType === 49 ||
      message.localType === 34359738417 ||
      message.localType === 103079215153 ||
      message.localType === 25769803825
    ) {
      if (message.appMsgKind === 'file' || message.xmlType === '6') return 'file'
      if (message.localType !== 49) return 'file'
    }
    return null
  }

  async getResourceMessages(options?: {
    sessionId?: string
    types?: ResourceMessageType[]
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }): Promise<{
    success: boolean
    items?: ResourceMessageItem[]
    total?: number
    hasMore?: boolean
    error?: string
  }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const requestedTypes = Array.isArray(options?.types)
        ? options.types.filter((type): type is ResourceMessageType => ['image', 'video', 'voice', 'file'].includes(type))
        : []
      const typeSet = new Set<ResourceMessageType>(requestedTypes.length > 0 ? requestedTypes : ['image', 'video', 'voice', 'file'])

      const beginTimestamp = Number(options?.beginTimestamp || 0)
      const endTimestamp = Number(options?.endTimestamp || 0)
      const offset = Math.max(0, Number(options?.offset || 0))
      const limitRaw = Number(options?.limit || 0)
      const limit = Number.isFinite(limitRaw) ? Math.min(2000, Math.max(1, Math.floor(limitRaw || 300))) : 300

      const sessionsResult = await this.host.getSessions()
      if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) {
        return { success: false, error: sessionsResult.error || '获取会话失败' }
      }

      const sessionNameMap = new Map<string, string>()
      sessionsResult.sessions.forEach((session) => {
        sessionNameMap.set(session.username, session.displayName || session.username)
      })

      const requestedSessionId = String(options?.sessionId || '').trim()
      const sortedSessions = [...sessionsResult.sessions].sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0))
      const targetSessionIds = requestedSessionId
        ? [requestedSessionId]
        : sortedSessions.map((session) => session.username)

      const localTypes: number[] = []
      if (typeSet.has('image')) localTypes.push(3)
      if (typeSet.has('video')) localTypes.push(43)
      if (typeSet.has('voice')) localTypes.push(34)
      if (typeSet.has('file')) {
        localTypes.push(49, 34359738417, 103079215153, 25769803825)
      }
      const uniqueLocalTypes = Array.from(new Set(localTypes))

      const allItems: ResourceMessageItem[] = []
      const dedup = new Set<string>()
      const targetCount = offset + limit
      const candidateBuffer = Math.max(180, limit)
      const perTypeFetch = requestedSessionId
        ? Math.min(2000, Math.max(200, targetCount * 2))
        : (beginTimestamp > 0 || endTimestamp > 0 ? 140 : 90)
      const maxSessionScan = requestedSessionId
        ? 1
        : (beginTimestamp > 0 || endTimestamp > 0 ? 240 : 80)
      const scanSessionIds = targetSessionIds.slice(0, maxSessionScan)

      let maybeHasMore = targetSessionIds.length > scanSessionIds.length
      let stopEarly = false

      for (const sessionId of scanSessionIds) {
        const batchRows = await Promise.all(
          uniqueLocalTypes.map((localType) =>
            wcdbService.getMessagesByType(sessionId, localType, false, perTypeFetch, 0)
          )
        )
        for (const result of batchRows) {
          if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) continue
          if (result.rows.length >= perTypeFetch) maybeHasMore = true

          const mapped = mapRowsToMessages(result.rows as Record<string, any>[], sessionId, String(this.host.getMyWxidCleaned() || '').trim())
          for (const message of mapped) {
            const resourceType = this.resolveResourceType(message)
            if (!resourceType || !typeSet.has(resourceType)) continue
            if (beginTimestamp > 0 && message.createTime < beginTimestamp) continue
            if (endTimestamp > 0 && message.createTime > endTimestamp) continue

            const dedupKey = `${sessionId}:${message.localId}:${message.serverId}:${message.createTime}:${message.localType}`
            if (dedup.has(dedupKey)) continue
            dedup.add(dedupKey)

            allItems.push({
              ...message,
              sessionId,
              sessionDisplayName: sessionNameMap.get(sessionId) || sessionId,
              resourceType
            })
          }
        }

        if (allItems.length >= targetCount + candidateBuffer) {
          stopEarly = true
          maybeHasMore = true
          break
        }
      }

      allItems.sort((a, b) => {
        const timeDiff = (b.createTime || 0) - (a.createTime || 0)
        if (timeDiff !== 0) return timeDiff
        return (b.localId || 0) - (a.localId || 0)
      })

      const total = allItems.length
      const start = Math.min(offset, total)
      const end = Math.min(start + limit, total)

      return {
        success: true,
        items: allItems.slice(start, end),
        total,
        hasMore: end < total || maybeHasMore || stopEarly
      }
    } catch (e) {
      console.error('[ChatService] 获取资源消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

}
