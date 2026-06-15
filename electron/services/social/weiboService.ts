import https from 'https'
import { createHash } from 'crypto'
import { URL } from 'url'

const WEIBO_TIMEOUT_MS = 10_000
const WEIBO_MAX_POSTS = 5
const WEIBO_CACHE_TTL_MS = 30 * 60 * 1000
const WEIBO_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
const WEIBO_MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

interface BrowserCookieEntry {
  domain?: string
  name?: string
  value?: string
}

interface WeiboUserInfo {
  id?: number | string
  screen_name?: string
}

interface WeiboWaterFallItem {
  id?: number | string
  idstr?: string
  mblogid?: string
  created_at?: string
  text_raw?: string
  isLongText?: boolean
  user?: WeiboUserInfo
  retweeted_status?: WeiboWaterFallItem
}

interface WeiboWaterFallResponse {
  ok?: number
  data?: {
    list?: WeiboWaterFallItem[]
    next_cursor?: string
  }
}

interface WeiboStatusShowResponse {
  id?: number | string
  idstr?: string
  mblogid?: string
  created_at?: string
  text_raw?: string
  user?: WeiboUserInfo
  retweeted_status?: WeiboWaterFallItem
}

interface MWeiboCard {
  mblog?: WeiboWaterFallItem
  card_group?: MWeiboCard[]
}

interface MWeiboContainerResponse {
  ok?: number
  data?: {
    cards?: MWeiboCard[]
  }
}

export interface WeiboRecentPost {
  id: string
  createdAt: string
  url: string
  text: string
  screenName?: string
}

interface CachedRecentPosts {
  expiresAt: number
  posts: WeiboRecentPost[]
}

function requestJson<T>(url: string, options: { cookie?: string; referer?: string; userAgent?: string }): Promise<T> {
  return new Promise((resolve, reject) => {
    let urlObj: URL
    try {
      urlObj = new URL(url)
    } catch {
      reject(new Error(`无效的微博请求地址：${url}`))
      return
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Referer: options.referer || 'https://weibo.com',
      'User-Agent': options.userAgent || WEIBO_USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest'
    }
    if (options.cookie) {
      headers.Cookie = options.cookie
    }

    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          const statusCode = res.statusCode || 0
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`微博接口返回异常状态码 ${statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(raw) as T)
          } catch {
            reject(new Error('微博接口返回了非 JSON 响应'))
          }
        })
      }
    )

    req.setTimeout(WEIBO_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('微博请求超时'))
    })

    req.on('error', reject)
    req.end()
  })
}

function normalizeCookieArray(entries: BrowserCookieEntry[]): string {
  const picked = new Map<string, string>()

  for (const entry of entries) {
    const name = String(entry?.name || '').trim()
    const value = String(entry?.value || '').trim()
    const domain = String(entry?.domain || '').trim().toLowerCase()

    if (!name || !value) continue
    if (domain && !domain.includes('weibo.com') && !domain.includes('weibo.cn')) continue

    picked.set(name, value)
  }

  return Array.from(picked.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

export function normalizeWeiboCookieInput(rawInput: string): string {
  const trimmed = String(rawInput || '').trim()
  if (!trimmed) return ''

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      const normalized = normalizeCookieArray(parsed as BrowserCookieEntry[])
      if (normalized) return normalized
      throw new Error('Cookie JSON 中未找到可用的微博 Cookie 项')
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }

  return trimmed.replace(/^Cookie:\s*/i, '').trim()
}

function normalizeWeiboUid(input: string): string {
  const trimmed = String(input || '').trim()
  const directMatch = trimmed.match(/^\d{5,}$/)
  if (directMatch) return directMatch[0]

  const linkMatch = trimmed.match(/(?:weibo\.com|m\.weibo\.cn)\/u\/(\d{5,})/i)
  if (linkMatch) return linkMatch[1]

  throw new Error('请输入有效的微博 UID（纯数字）')
}

function sanitizeWeiboText(text: string): string {
  return String(text || '')
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/https?:\/\/t\.cn\/[A-Za-z0-9]+/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function mergeRetweetText(item: Pick<WeiboWaterFallItem, 'text_raw' | 'retweeted_status'>): string {
  const baseText = sanitizeWeiboText(item.text_raw || '')
  const retweetText = sanitizeWeiboText(item.retweeted_status?.text_raw || '')
  if (!retweetText) return baseText
  if (!baseText || baseText === '转发微博') return `转发：${retweetText}`
  return `${baseText}\n\n转发内容：${retweetText}`
}

function buildCacheKey(uid: string, count: number, cookie: string): string {
  const cookieHash = createHash('sha1').update(cookie).digest('hex')
  return `${uid}:${count}:${cookieHash}`
}

class WeiboService {
  private recentPostsCache = new Map<string, CachedRecentPosts>()

  clearCache(): void {
    this.recentPostsCache.clear()
  }

  async validateUid(
    uidInput: string,
    cookieInput: string
  ): Promise<{ success: boolean; uid?: string; screenName?: string; error?: string }> {
    try {
      const uid = normalizeWeiboUid(uidInput)
      const cookie = normalizeWeiboCookieInput(cookieInput)
      if (!cookie) {
        return { success: true, uid }
      }

      const timeline = await this.fetchTimeline(uid, cookie)
      const firstItem = timeline.data?.list?.[0]
      if (!firstItem) {
        return { success: false, error: '该微博账号暂无可读取的近期公开内容，或当前 Cookie 已失效' }
      }

      return {
        success: true,
        uid,
        screenName: firstItem.user?.screen_name
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message || '微博 UID 校验失败'
      }
    }
  }

  async fetchRecentPosts(
    uidInput: string,
    cookieInput: string,
    requestedCount: number
  ): Promise<WeiboRecentPost[]> {
    const uid = normalizeWeiboUid(uidInput)
    const cookie = normalizeWeiboCookieInput(cookieInput)
    const hasCookie = Boolean(cookie)

    const count = Math.max(1, Math.min(WEIBO_MAX_POSTS, Math.floor(Number(requestedCount) || 0)))
    const cacheKey = buildCacheKey(uid, count, hasCookie ? cookie : '__no_cookie_mobile__')
    const cached = this.recentPostsCache.get(cacheKey)
    const now = Date.now()

    if (cached && cached.expiresAt > now) {
      return cached.posts
    }

    const rawItems = hasCookie
      ? (await this.fetchTimeline(uid, cookie)).data?.list || []
      : await this.fetchMobileTimeline(uid)
    const posts: WeiboRecentPost[] = []

    for (const item of rawItems) {
      if (posts.length >= count) break

      const id = String(item.idstr || item.id || '').trim()
      if (!id) continue

      let text = mergeRetweetText(item)
      if (item.isLongText && hasCookie) {
        try {
          const detail = await this.fetchDetail(id, cookie)
          text = mergeRetweetText(detail)
        } catch {
          // 长文补抓失败时回退到列表摘要
        }
      }

      text = sanitizeWeiboText(text)
      if (!text) continue

      posts.push({
        id,
        createdAt: String(item.created_at || ''),
        url: `https://m.weibo.cn/detail/${id}`,
        text,
        screenName: item.user?.screen_name
      })
    }

    this.recentPostsCache.set(cacheKey, {
      expiresAt: now + WEIBO_CACHE_TTL_MS,
      posts
    })

    return posts
  }

  private fetchTimeline(uid: string, cookie: string): Promise<WeiboWaterFallResponse> {
    return requestJson<WeiboWaterFallResponse>(
      `https://weibo.com/ajax/profile/getWaterFallContent?uid=${encodeURIComponent(uid)}`,
      {
        cookie,
        referer: `https://weibo.com/u/${encodeURIComponent(uid)}`
      }
    ).then((response) => {
      if (response.ok !== 1 || !Array.isArray(response.data?.list)) {
        throw new Error('微博时间线获取失败，请检查 Cookie 是否仍然有效')
      }
      return response
    })
  }

  private fetchMobileTimeline(uid: string): Promise<WeiboWaterFallItem[]> {
    const containerid = `107603${uid}`
    return requestJson<MWeiboContainerResponse>(
      `https://m.weibo.cn/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}&containerid=${encodeURIComponent(containerid)}`,
      {
        referer: `https://m.weibo.cn/u/${encodeURIComponent(uid)}`,
        userAgent: WEIBO_MOBILE_USER_AGENT
      }
    ).then((response) => {
      if (response.ok !== 1 || !Array.isArray(response.data?.cards)) {
        throw new Error('微博时间线获取失败，请稍后重试')
      }

      const rows: WeiboWaterFallItem[] = []
      for (const card of response.data.cards) {
        if (card?.mblog) rows.push(card.mblog)
        if (Array.isArray(card?.card_group)) {
          for (const subCard of card.card_group) {
            if (subCard?.mblog) rows.push(subCard.mblog)
          }
        }
      }

      if (rows.length === 0) {
        throw new Error('该微博账号暂无可读取的近期公开内容')
      }

      return rows
    })
  }

  private fetchDetail(id: string, cookie: string): Promise<WeiboStatusShowResponse> {
    return requestJson<WeiboStatusShowResponse>(
      `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(id)}&isGetLongText=true`,
      {
        cookie,
        referer: `https://weibo.com/detail/${encodeURIComponent(id)}`
      }
    ).then((response) => {
      if (!response || (!response.id && !response.idstr)) {
        throw new Error('微博详情获取失败')
      }
      return response
    })
  }
}

export const weiboService = new WeiboService()
