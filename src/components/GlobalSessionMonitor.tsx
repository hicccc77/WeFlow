import { useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import type { ChatSession, Message } from '../types/models'
import { useNavigate } from 'react-router-dom'

export function GlobalSessionMonitor() {
    const navigate = useNavigate()
    const {
        sessions,
        setSessions,
        currentSessionId,
        appendMessages,
        messages
    } = useChatStore()

    const sessionsRef = useRef(sessions)
    // 保持 ref 同步
    useEffect(() => {
        sessionsRef.current = sessions
    }, [sessions])

    // 去重辅助函数：获取消息 key
    const getMessageKey = (msg: Message) => {
        if (msg.messageKey) return msg.messageKey
        return `fallback:${msg._db_path || ''}:${msg.serverId || 0}:${msg.createTime}:${msg.sortSeq || 0}:${msg.localId || 0}:${msg.senderUsername || ''}:${msg.localType || 0}`
    }

    // 处理数据库变更
    useEffect(() => {
        const handleDbChange = (_event: any, data: { type: string; json: string }) => {
            try {
                const payload = JSON.parse(data.json)
                const tableName = payload.table

                // 只关注 Session 表
                if (tableName === 'Session' || tableName === 'session') {
                    refreshSessions()
                }
            } catch (e) {
                console.error('解析数据库变更失败:', e)
            }
        }

        if (window.electronAPI.chat.onWcdbChange) {
            const removeListener = window.electronAPI.chat.onWcdbChange(handleDbChange)
            return () => {
                removeListener()
            }
        }
        return () => { }
    }, [])

    const refreshSessions = async () => {
        try {
            const result = await window.electronAPI.chat.getSessions()
            if (result.success && result.sessions && Array.isArray(result.sessions)) {
                const newSessions = result.sessions as ChatSession[]
                const oldSessions = sessionsRef.current

                // 1. 检测变更并通知
                checkForNewMessages(oldSessions, newSessions)

                // 2. 更新 store
                setSessions(newSessions)

                // 3. 如果在活跃会话中，增量刷新消息
                const currentId = useChatStore.getState().currentSessionId
                if (currentId) {
                    const currentSessionNew = newSessions.find(s => s.username === currentId)
                    const currentSessionOld = oldSessions.find(s => s.username === currentId)

                    if (currentSessionNew && (!currentSessionOld || currentSessionNew.lastTimestamp > currentSessionOld.lastTimestamp)) {
                        void handleActiveSessionRefresh(currentId)
                    }
                }
            }
        } catch (e) {
            console.error('全局会话刷新失败:', e)
        }
    }

    const checkForNewMessages = async (oldSessions: ChatSession[], newSessions: ChatSession[]) => {
        if (!oldSessions || oldSessions.length === 0) {
            console.log('[NotificationFilter] Skipping check on initial load (empty baseline)')
            return
        }

        const oldMap = new Map(oldSessions.map(s => [s.username, s]))

        for (const newSession of newSessions) {
            const oldSession = oldMap.get(newSession.username)

            // 条件: 新会话或时间戳更新
            const isCurrentSession = newSession.username === useChatStore.getState().currentSessionId

            if (!isCurrentSession && (!oldSession || newSession.lastTimestamp > oldSession.lastTimestamp)) {
                // 这是新消息事件

                // 免打扰、折叠群、折叠入口不弹通知
                if (newSession.isMuted || newSession.isFolded) continue
                if (newSession.username.toLowerCase().includes('placeholder_foldgroup')) continue

                // 1. 群聊过滤自己发送的消息
                if (newSession.username.includes('@chatroom')) {
                    // 如果是自己发的消息，不弹通知
                    // 注意：lastMsgSender 需要后端支持返回
                    // 使用宽松比较以处理 wxid_ 前缀差异
                    if (newSession.lastMsgSender && newSession.selfWxid) {
                        const sender = newSession.lastMsgSender.replace(/^wxid_/, '');
                        const self = newSession.selfWxid.replace(/^wxid_/, '');

                        // 使用主进程日志打印，方便用户查看
                        const debugInfo = {
                            type: 'NotificationFilter',
                            username: newSession.username,
                            lastMsgSender: newSession.lastMsgSender,
                            selfWxid: newSession.selfWxid,
                            senderClean: sender,
                            selfClean: self,
                            match: sender === self
                        };

                        if (window.electronAPI.log?.debug) {
                            window.electronAPI.log.debug(debugInfo);
                        } else {
                            console.log('[NotificationFilter]', debugInfo);
                        }

                        if (sender === self) {
                            if (window.electronAPI.log?.debug) {
                                window.electronAPI.log.debug('[NotificationFilter] Filtered own message');
                            } else {
                                console.log('[NotificationFilter] Filtered own message');
                            }
                            continue;
                        }
                    } else {
                        const missingInfo = {
                            type: 'NotificationFilter Missing info',
                            lastMsgSender: newSession.lastMsgSender,
                            selfWxid: newSession.selfWxid
                        };
                        if (window.electronAPI.log?.debug) {
                            window.electronAPI.log.debug(missingInfo);
                        } else {
                            console.log('[NotificationFilter] Missing info:', missingInfo);
                        }
                    }
                }

                // 新增：如果未读数量没有增加，说明可能是自己在其他设备回复（或者已读），不弹通知
                const oldUnread = oldSession ? oldSession.unreadCount : 0
                const newUnread = newSession.unreadCount
                if (newUnread <= oldUnread) {
                    // 仅仅是状态同步（如自己在手机上发消息 or 已读），跳过通知
                    continue
                }

                let title = newSession.displayName || newSession.username
                let avatarUrl = newSession.avatarUrl
                let content = newSession.summary || '[新消息]'

                if (newSession.username.includes('@chatroom')) {
                    // 1. 群聊过滤自己发送的消息
                    // 辅助函数：清理 wxid 后缀 (如 _8602)
                    const cleanWxid = (id: string) => {
                        if (!id) return '';
                        const trimmed = id.trim();
                        // 仅移除末尾的 _xxxx (4位字母数字)
                        const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/);
                        return suffixMatch ? suffixMatch[1] : trimmed;
                    }

                    if (newSession.lastMsgSender && newSession.selfWxid) {
                        const senderClean = cleanWxid(newSession.lastMsgSender);
                        const selfClean = cleanWxid(newSession.selfWxid);
                        const match = senderClean === selfClean;

                        if (match) {
                            continue;
                        }
                    }

                    // 2. 群聊显示发送者名字 (放在内容中: "Name: Message")
                    // 标题保持为群聊名称 (title 变量)
                    if (newSession.lastSenderDisplayName) {
                        content = `${newSession.lastSenderDisplayName}: ${content}`
                    }
                }

                // 修复 "Random User" 的逻辑 (缺少具体信息)
                // 如果标题看起来像 wxid 或没有头像，尝试获取信息
                const needsEnrichment = !newSession.displayName || !newSession.avatarUrl || newSession.displayName === newSession.username

                if (needsEnrichment && newSession.username) {
                    try {
                        // 尝试丰富或获取联系人详情
                        const contact = await window.electronAPI.chat.getContact(newSession.username)
                        if (contact) {
                            if (contact.remark || contact.nickName) {
                                title = contact.remark || contact.nickName
                            }
                            const avatarResult = await window.electronAPI.chat.getContactAvatar(newSession.username)
                            if (avatarResult?.avatarUrl) {
                                avatarUrl = avatarResult.avatarUrl
                            }
                        } else {
                            // 如果不在缓存/数据库中
                            const enrichResult = await window.electronAPI.chat.enrichSessionsContactInfo([newSession.username])
                            if (enrichResult.success && enrichResult.contacts) {
                                const enrichedContact = enrichResult.contacts[newSession.username]
                                if (enrichedContact) {
                                    if (enrichedContact.displayName) {
                                        title = enrichedContact.displayName
                                    }
                                    if (enrichedContact.avatarUrl) {
                                        avatarUrl = enrichedContact.avatarUrl
                                    }
                                }
                            }
                            // 如果仍然没有有效名称，再尝试一次获取
                            if (title === newSession.username || title.startsWith('wxid_')) {
                                const retried = await window.electronAPI.chat.getContact(newSession.username)
                                if (retried) {
                                    title = retried.remark || retried.nickName || title
                                    const retriedAvatar = await window.electronAPI.chat.getContactAvatar(newSession.username)
                                    if (retriedAvatar?.avatarUrl) {
                                        avatarUrl = retriedAvatar.avatarUrl
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('获取通知的联系人信息失败', e)
                    }
                }

                // 最终检查：如果标题仍是 wxid 格式，则跳过通知（避免显示乱跳用户）
                // 群聊例外，因为群聊 username 包含 @chatroom
                const isGroupChat = newSession.username.includes('@chatroom')
                const isWxidTitle = title.startsWith('wxid_') && title === newSession.username
                if (isWxidTitle && !isGroupChat) {
                    console.warn('[NotificationFilter] 跳过无法识别的用户通知:', newSession.username)
                    continue
                }

                // 调用 IPC 以显示独立窗口通知
                window.electronAPI.notification?.show({
                    title: title,
                    content: content,
                    avatarUrl: avatarUrl,
                    sessionId: newSession.username
                })

                // 我们不再为 Toast 设置本地状态
            }
        }
    }

    const handleActiveSessionRefresh = async (sessionId: string) => {
        // 从 ChatPage 复制/调整的逻辑，以保持集中
        const state = useChatStore.getState()
        const msgs = state.messages || []
        const lastMsg = msgs[msgs.length - 1]
        const minTime = lastMsg?.createTime || 0

        try {
            const result = await (window.electronAPI.chat as any).getNewMessages(sessionId, minTime)
            if (result.success && result.messages && result.messages.length > 0) {
                const latestMessages = useChatStore.getState().messages || []
                const existingKeys = new Set(latestMessages.map(getMessageKey))
                const newMessages = result.messages.filter((msg: Message) => !existingKeys.has(getMessageKey(msg)))
                if (newMessages.length > 0) {
                    appendMessages(newMessages, false)
                }
            }
        } catch (e) {
            console.warn('后台活跃会话刷新失败:', e)
        }
    }

    // 此组件不再渲染 UI
    return null
}
