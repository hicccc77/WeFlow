import { parentPort, workerData } from 'worker_threads'
import { WcdbCore } from './services/wcdbCore'

const core = new WcdbCore()

if (parentPort) {
    parentPort.on('message', async (msg) => {
        const { id, type, payload } = msg

        try {
            let result: any

            switch (type) {
                case 'setPaths':
                    core.setPaths(payload.resourcesPath, payload.userDataPath)
                    result = { success: true }
                    break
                case 'setLogEnabled':
                    core.setLogEnabled(payload.enabled)
                    result = { success: true }
                    break
                case 'setMonitor':
                    core.setMonitor((type, json) => {
                        parentPort!.postMessage({
                            id: -1,
                            type: 'monitor',
                            payload: { type, json }
                        })
                    })
                    result = { success: true }
                    break
                case 'testConnection':
                    result = await core.testConnection(payload.dbPath, payload.hexKey, payload.wxid)
                    break
                case 'open':
                    result = await core.open(payload.dbPath, payload.hexKey, payload.wxid)
                    break
                case 'close':
                    core.close()
                    result = { success: true }
                    break
                case 'isConnected':
                    result = core.isConnected()
                    break
                case 'getSessions':
                    result = await core.getSessions()
                    break
                case 'getMessages':
                    result = await core.getMessages(payload.sessionId, payload.limit, payload.offset)
                    break
                case 'getNewMessages':
                    result = await core.getNewMessages(payload.sessionId, payload.minTime, payload.limit)
                    break
                case 'getMessageCount':
                    result = await core.getMessageCount(payload.sessionId)
                    break
                case 'getDisplayNames':
                    result = await core.getDisplayNames(payload.usernames)
                    break
                case 'getAvatarUrls':
                    result = await core.getAvatarUrls(payload.usernames)
                    break
                case 'getGroupMemberCount':
                    result = await core.getGroupMemberCount(payload.chatroomId)
                    break
                case 'getGroupMemberCounts':
                    result = await core.getGroupMemberCounts(payload.chatroomIds)
                    break
                case 'getGroupMembers':
                    result = await core.getGroupMembers(payload.chatroomId)
                    break
                case 'getGroupNicknames':
                    result = await core.getGroupNicknames(payload.chatroomId)
                    break
                case 'getMessageTables':
                    result = await core.getMessageTables(payload.sessionId)
                    break
                case 'getMessageTableStats':
                    result = await core.getMessageTableStats(payload.sessionId)
                    break
                case 'getMessageDates':
                    result = await core.getMessageDates(payload.sessionId)
                    break
                case 'getMessageMeta':
                    result = await core.getMessageMeta(payload.dbPath, payload.tableName, payload.limit, payload.offset)
                    break
                case 'getContact':
                    result = await core.getContact(payload.username)
                    break
                case 'getAggregateStats':
                    result = await core.getAggregateStats(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getAvailableYears':
                    result = await core.getAvailableYears(payload.sessionIds)
                    break
                case 'getAnnualReportStats':
                    result = await core.getAnnualReportStats(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getAnnualReportExtras':
                    result = await core.getAnnualReportExtras(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp, payload.peakDayBegin, payload.peakDayEnd)
                    break
                case 'getDualReportStats':
                    result = await core.getDualReportStats(payload.sessionId, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getGroupStats':
                    result = await core.getGroupStats(payload.chatroomId, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'openMessageCursor':
                    result = await core.openMessageCursor(payload.sessionId, payload.batchSize, payload.ascending, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'openMessageCursorLite':
                    result = await core.openMessageCursorLite(payload.sessionId, payload.batchSize, payload.ascending, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'fetchMessageBatch':
                    result = await core.fetchMessageBatch(payload.cursor)
                    break
                case 'closeMessageCursor':
                    result = await core.closeMessageCursor(payload.cursor)
                    break
                case 'execQuery':
                    result = await core.execQuery(payload.kind, payload.path, payload.sql)
                    break
                case 'getEmoticonCdnUrl':
                    result = await core.getEmoticonCdnUrl(payload.dbPath, payload.md5)
                    break
                case 'listMessageDbs':
                    result = await core.listMessageDbs()
                    break
                case 'listMediaDbs':
                    result = await core.listMediaDbs()
                    break
                case 'getMessageById':
                    result = await core.getMessageById(payload.sessionId, payload.localId)
                    break
                case 'getVoiceData':
                    result = await core.getVoiceData(payload.sessionId, payload.createTime, payload.candidates, payload.localId, payload.svrId)
                    if (!result.success) {
                        console.error('[wcdbWorker] getVoiceData failed:', result.error)
                    }
                    break
                case 'getSnsTimeline':
                    result = await core.getSnsTimeline(payload.limit, payload.offset, payload.usernames, payload.keyword, payload.startTime, payload.endTime)
                    break
                case 'getSnsAnnualStats':
                    result = await core.getSnsAnnualStats(payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getLogs':
                    result = await core.getLogs()
                    break
                case 'verifyUser':
                    result = await core.verifyUser(payload.message, payload.hwnd)
                    break
                case 'decryptSnsImage':
                    result = await core.decryptSnsImage(payload.encryptedData, payload.key)
                    break
                default:
                    result = { success: false, error: `Unknown method: ${type}` }
            }

            parentPort!.postMessage({ id, result })
        } catch (e) {
            parentPort!.postMessage({ id, error: String(e) })
        }
    })
}
