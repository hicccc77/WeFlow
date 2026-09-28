import type { Message } from '../../types/models'

export interface NewMessagesCursor {
  createTime: number
  sortSeq?: number
  localId?: number
  serverId?: number | string
  serverIdRaw?: string
}

export function buildNewMessagesCursor(message?: Pick<Message, 'createTime' | 'sortSeq' | 'localId' | 'serverId' | 'serverIdRaw'>): NewMessagesCursor | undefined {
  if (!message) return undefined
  return {
    createTime: Number(message.createTime || 0),
    sortSeq: Number(message.sortSeq || 0),
    localId: Number(message.localId || 0),
    serverId: message.serverId,
    serverIdRaw: message.serverIdRaw
  }
}
