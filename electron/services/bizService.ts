import { join } from 'path'
import { readdirSync, existsSync } from 'fs'
import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { chatService, Message } from './chatService'
import { ipcMain } from 'electron'
import { createHash } from 'crypto'

export interface BizAccount {
  username: string
  name: string
  avatar: string
  type: number
  last_time: number
  formatted_last_time: string
  unread_count?: number
}

export interface BizMessage {
  local_id: number
  create_time: number
  title: string
  des: string
  url: string
  cover: string
  content_list: any[]
}

export interface BizPayRecord {
  local_id: number
  create_time: number
  title: string
  description: string
  merchant_name: string
  merchant_icon: string
  timestamp: number
  formatted_time: string
}

export class BizService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

  private parseBizContentList(xmlStr: string): any[] {
    if (!xmlStr) return []
    const contentList: any[] = []
    try {
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi
      let match: RegExpExecArray | null
      while ((match = itemRegex.exec(xmlStr)) !== null) {
        const itemXml = match[1]
        const itemStruct = {
          title: this.extractXmlValue(itemXml, 'title'),
          url: this.extractXmlValue(itemXml, 'url'),
          cover: this.extractXmlValue(itemXml, 'cover') || this.extractXmlValue(itemXml, 'thumburl'),
          summary: this.extractXmlValue(itemXml, 'summary') || this.extractXmlValue(itemXml, 'digest')
        }
        if (itemStruct.title) contentList.push(itemStruct)
      }
    } catch (e) { }
    return contentList
  }

  private parsePayXml(xmlStr: string): any {
    if (!xmlStr) return null
    try {
      const title = this.extractXmlValue(xmlStr, 'title')
      const description = this.extractXmlValue(xmlStr, 'des')
      const merchantName = this.extractXmlValue(xmlStr, 'display_name') || '微信支付'
      const merchantIcon = this.extractXmlValue(xmlStr, 'icon_url')
      const pubTime = parseInt(this.extractXmlValue(xmlStr, 'pub_time') || '0')
      if (!title && !description) return null
      return { title, description, merchant_name: merchantName, merchant_icon: merchantIcon, timestamp: pubTime }
    } catch (e) { return null }
  }

  async listAccounts(account?: string): Promise<BizAccount[]> {
    try {
      // 1. 获取公众号联系人列表
      const contactsResult = await chatService.getContacts({ lite: true })
      if (!contactsResult.success || !contactsResult.contacts) return []

      const officialContacts = contactsResult.contacts.filter(c => c.type === 'official')
      const usernames = officialContacts.map(c => c.username)

      // 获取头像和昵称等补充信息
      const enrichment = await chatService.enrichSessionsContactInfo(usernames)
      const contactInfoMap = enrichment.success && enrichment.contacts ? enrichment.contacts : {}

      const root = this.configService.get('dbPath')
      const myWxid = this.configService.get('myWxid')
      const accountWxid = account || myWxid
      if (!root || !accountWxid) return []

      const bizLatestTime: Record<string, number> = {}
      const bizUnreadCount: Record<string, number> = {}

      try {
        const sessionsRes = await chatService.getSessions()
        if (sessionsRes.success && sessionsRes.sessions) {
          for (const session of sessionsRes.sessions) {
            const uname = session.username || session.strUsrName || session.userName || session.id
            // 适配日志中发现的字段，注意转为整型数字
            const timeStr = session.lastTimestamp || session.sortTimestamp || session.last_timestamp || session.sort_timestamp || session.nTime || session.timestamp || '0'
            const time = parseInt(timeStr.toString(), 10)

            if (usernames.includes(uname) && time > 0) {
              bizLatestTime[uname] = time
            }
            if (usernames.includes(uname)) {
              const unread = Number(session.unreadCount ?? session.unread_count ?? 0)
              bizUnreadCount[uname] = Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : 0
            }
          }
        }
      } catch (e) {
        console.error('获取 Sessions 失败:', e)
      }

      // 3. 格式化时间显示
      const formatBizTime = (ts: number) => {
        if (!ts) return ''
        const date = new Date(ts * 1000)
        const now = new Date()
        const isToday = date.toDateString() === now.toDateString()
        if (isToday) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

        const yesterday = new Date(now)
        yesterday.setDate(now.getDate() - 1)
        if (date.toDateString() === yesterday.toDateString()) return '昨天'

        const isThisYear = date.getFullYear() === now.getFullYear()
        if (isThisYear) return `${date.getMonth() + 1}/${date.getDate()}`

        return `${date.getFullYear().toString().slice(-2)}/${date.getMonth() + 1}/${date.getDate()}`
      }

      // 4. 组装数据
      const result: BizAccount[] = officialContacts.map(contact => {
        const uname = contact.username
        const info = contactInfoMap[uname]
        const lastTime = bizLatestTime[uname] || 0
        return {
          username: uname,
          name: info?.displayName || contact.displayName || uname,
          avatar: info?.avatarUrl || '',
          type: 0,
          last_time: lastTime,
          formatted_last_time: formatBizTime(lastTime),
          unread_count: bizUnreadCount[uname] || 0
        }
      })

      // 5. 补充公众号类型 (订阅号/服务号)
      const contactDbPath = join(root, accountWxid, 'db_storage', 'contact', 'contact.db')
      if (existsSync(contactDbPath)) {
        const bizInfoRes = await wcdbService.execQuery('contact', contactDbPath, 'SELECT username, type FROM biz_info')
        if (bizInfoRes.success && bizInfoRes.rows) {
          const typeMap: Record<string, number> = {}
          for (const r of bizInfoRes.rows) typeMap[r.username] = r.type
          for (const acc of result) if (typeMap[acc.username] !== undefined) acc.type = typeMap[acc.username]
        }
      }

      // 6. 排序输出
      return result
          .filter(acc => !acc.name.includes('广告'))
          .sort((a, b) => {
            if (a.username === 'gh_3dfda90e39d6') return -1 // 微信支付置顶
            if (b.username === 'gh_3dfda90e39d6') return 1
            return b.last_time - a.last_time // 按最新时间降序排列
          })
    } catch (e) {
      console.error('获取账号列表发生错误:', e)
      return []
    }
  }

  async listMessages(username: string, account?: string, limit: number = 20, offset: number = 0): Promise<BizMessage[]> {
    try {
      // 仅保留核心路径：利用 chatService 的自动路由能力
      const res = await chatService.getMessages(username, offset, limit)
      if (!res.success || !res.messages) return []

      return res.messages.map(msg => {
        const bizMsg: BizMessage = {
          local_id: msg.localId,
          create_time: msg.createTime,
          title: msg.linkTitle || msg.parsedContent || '',
          des: msg.appMsgDesc || '',
          url: msg.linkUrl || '',
          cover: msg.linkThumb || msg.appMsgThumbUrl || '',
          content_list: []
        }
        if (msg.rawContent) {
          bizMsg.content_list = this.parseBizContentList(msg.rawContent)
          if (bizMsg.content_list.length > 0 && !bizMsg.title) {
            bizMsg.title = bizMsg.content_list[0].title
            bizMsg.cover = bizMsg.cover || bizMsg.content_list[0].cover
          }
        }
        return bizMsg
      })
    } catch (e) { return [] }
  }

  async listPayRecords(account?: string, limit: number = 20, offset: number = 0): Promise<BizPayRecord[]> {
    const username = 'gh_3dfda90e39d6'
    try {
      const res = await chatService.getMessages(username, offset, limit)
      if (!res.success || !res.messages) return []

      const records: BizPayRecord[] = []
      for (const msg of res.messages) {
        if (!msg.rawContent) continue
        const parsedData = this.parsePayXml(msg.rawContent)
        if (parsedData) {
          records.push({
            local_id: msg.localId,
            create_time: msg.createTime,
            ...parsedData,
            timestamp: parsedData.timestamp || msg.createTime,
            formatted_time: new Date((parsedData.timestamp || msg.createTime) * 1000).toLocaleString()
          })
        }
      }
      return records
    } catch (e) { return [] }
  }

  registerHandlers() {
    ipcMain.handle('biz:listAccounts', (_, account) => this.listAccounts(account))
    ipcMain.handle('biz:listMessages', (_, username, account, limit, offset) => this.listMessages(username, account, limit, offset))
    ipcMain.handle('biz:listPayRecords', (_, account, limit, offset) => this.listPayRecords(account, limit, offset))
  }
}

export const bizService = new BizService()
