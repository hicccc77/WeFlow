import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { ipcMain } from 'electron'

export interface BizAccount {
  username: string
  name: string
  avatar: string
  type: number
  last_time: number
  formatted_last_time: string
  unread_count?: number
  status?: 'active' | 'inactive'
  health_reason?: string
  stale_level?: 'none' | 'one_year' | 'two_year' | 'unknown'
  days_since_last_article?: number
}

export interface BizAccountHealth {
  summary: {
    active_total: number
    subscription_total: number
    service_total: number
    invalid_total: number
    stale_one_year_total: number
    stale_two_year_total: number
    unknown_last_article_total: number
  }
  accounts: BizAccount[]
  invalid_accounts: BizAccount[]
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
  private readonly builtinOfficialHelpers = new Set([
    'gh_f0a92aa7146c' // 微信收款助手不出现在通讯录的公众号/服务号分组里
  ])

  constructor() {
    this.configService = new ConfigService()
  }

  private isVisibleOfficialAccount(username: string, localType: number): boolean {
    return username.startsWith('gh_') && localType === 1 && !this.builtinOfficialHelpers.has(username)
  }

  private toInt(value: unknown, fallback: number = 0): number {
    const parsed = Number.parseInt(String(value ?? ''), 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private getRowString(row: Record<string, any>, keys: string[]): string {
    for (const key of keys) {
      const value = row[key]
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
    }
    return ''
  }

  private formatBizTime(ts: number): string {
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

      const myWxid = this.configService.getMyWxidCleaned()
      const accountWxid = account || myWxid
      if (!accountWxid) return []

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
          formatted_last_time: this.formatBizTime(lastTime),
          unread_count: bizUnreadCount[uname] || 0,
          status: 'active',
          stale_level: 'none'
        }
      })

      // 5. 补充公众号类型 (订阅号/服务号)
      const bizInfoRes = await wcdbService.execQuery('contact', null, 'SELECT username, type FROM biz_info')
      if (bizInfoRes.success && bizInfoRes.rows) {
        const typeMap: Record<string, number> = {}
        for (const r of bizInfoRes.rows as Array<Record<string, any>>) typeMap[String(r.username || '')] = this.toInt(r.type)
        for (const acc of result) if (typeMap[acc.username] !== undefined) acc.type = typeMap[acc.username]
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

  async listAccountHealth(account?: string): Promise<BizAccountHealth> {
    const empty: BizAccountHealth = {
      summary: {
        active_total: 0,
        subscription_total: 0,
        service_total: 0,
        invalid_total: 0,
        stale_one_year_total: 0,
        stale_two_year_total: 0,
        unknown_last_article_total: 0
      },
      accounts: [],
      invalid_accounts: []
    }

    try {
      const contactsRes = await wcdbService.execQuery(
        'contact',
        null,
        "SELECT username, nick_name, remark, alias, local_type, delete_flag, verify_flag, flag FROM contact WHERE username LIKE 'gh_%'"
      )
      if (!contactsRes.success || !Array.isArray(contactsRes.rows)) return empty

      const bizInfoRes = await wcdbService.execQuery('contact', null, 'SELECT username, type FROM biz_info')
      const typeMap: Record<string, number> = {}
      if (bizInfoRes.success && Array.isArray(bizInfoRes.rows)) {
        for (const row of bizInfoRes.rows as Array<Record<string, any>>) {
          const username = String(row.username || '').trim()
          if (username) typeMap[username] = this.toInt(row.type)
        }
      }

      const rows = contactsRes.rows as Array<Record<string, any>>
      const usernames = rows.map((row) => String(row.username || '').trim()).filter(Boolean)
      const enrichment = await chatService.enrichSessionsContactInfo(usernames)
      const contactInfoMap = enrichment.success && enrichment.contacts ? enrichment.contacts : {}

      const latestTime: Record<string, number> = {}
      const unreadCount: Record<string, number> = {}
      try {
        const sessionsRes = await chatService.getSessions()
        if (sessionsRes.success && sessionsRes.sessions) {
          for (const session of sessionsRes.sessions) {
            const username = String(session.username || session.strUsrName || session.userName || session.id || '').trim()
            if (!username) continue
            const time = this.toInt(session.lastTimestamp || session.sortTimestamp || session.last_timestamp || session.sort_timestamp || session.nTime || session.timestamp)
            if (time > 0) latestTime[username] = time
            const unread = Number(session.unreadCount ?? session.unread_count ?? 0)
            unreadCount[username] = Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : 0
          }
        }
      } catch (e) {
        console.error('获取 Sessions 失败:', e)
      }

      const nowSeconds = Math.floor(Date.now() / 1000)
      const oneYearSeconds = 365 * 24 * 60 * 60
      const accounts: BizAccount[] = []
      const invalidAccounts: BizAccount[] = []

      for (const row of rows) {
        const username = String(row.username || '').trim()
        if (!username || this.builtinOfficialHelpers.has(username)) continue
        const hasBizInfo = typeMap[username] !== undefined
        if (!hasBizInfo) continue

        const localType = this.toInt(row.local_type ?? row.localType)
        const info = contactInfoMap[username]
        const lastTime = latestTime[username] || 0
        const isActive = this.isVisibleOfficialAccount(username, localType)
        let staleLevel: BizAccount['stale_level'] = 'none'
        let daysSinceLastArticle: number | undefined
        if (!lastTime) {
          staleLevel = 'unknown'
        } else {
          daysSinceLastArticle = Math.max(0, Math.floor((nowSeconds - lastTime) / 86400))
          if (nowSeconds - lastTime >= oneYearSeconds * 2) staleLevel = 'two_year'
          else if (nowSeconds - lastTime >= oneYearSeconds) staleLevel = 'one_year'
        }

        const accountInfo: BizAccount = {
          username,
          name: info?.displayName || this.getRowString(row, ['remark', 'nick_name', 'alias']) || username,
          avatar: info?.avatarUrl || '',
          type: typeMap[username] ?? 3,
          last_time: lastTime,
          formatted_last_time: this.formatBizTime(lastTime),
          unread_count: unreadCount[username] || 0,
          status: isActive ? 'active' : 'inactive',
          health_reason: isActive ? undefined : '不在微信通讯录的公众号/服务号有效分组中，可能是历史残留、已取消关注或已失效账号',
          stale_level: staleLevel,
          days_since_last_article: daysSinceLastArticle
        }

        if (isActive) accounts.push(accountInfo)
        else invalidAccounts.push(accountInfo)
      }

      const sortAccounts = (items: BizAccount[]) => items.sort((a, b) => {
        if (a.username === 'gh_3dfda90e39d6') return -1
        if (b.username === 'gh_3dfda90e39d6') return 1
        return (b.last_time || 0) - (a.last_time || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN')
      })

      sortAccounts(accounts)
      sortAccounts(invalidAccounts)
      return {
        summary: {
          active_total: accounts.length,
          subscription_total: accounts.filter((item) => item.type === 0).length,
          service_total: accounts.filter((item) => item.type === 1).length,
          invalid_total: invalidAccounts.length,
          stale_one_year_total: accounts.filter((item) => item.stale_level === 'one_year' || item.stale_level === 'two_year').length,
          stale_two_year_total: accounts.filter((item) => item.stale_level === 'two_year').length,
          unknown_last_article_total: accounts.filter((item) => item.stale_level === 'unknown').length
        },
        accounts,
        invalid_accounts: invalidAccounts
      }
    } catch (e) {
      console.error('获取公众号健康状态失败:', e)
      return empty
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
    ipcMain.handle('biz:listAccountHealth', (_, account) => this.listAccountHealth(account))
    ipcMain.handle('biz:listMessages', (_, username, account, limit, offset) => this.listMessages(username, account, limit, offset))
    ipcMain.handle('biz:listPayRecords', (_, account, limit, offset) => this.listPayRecords(account, limit, offset))
  }
}

export const bizService = new BizService()
