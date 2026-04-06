import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { ContactCacheService } from './contactCacheService'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { basename, join } from 'path'
import crypto from 'crypto'
import { WasmService } from './wasmService'
import zlib from 'zlib'

export interface SnsLivePhoto {
    url: string
    thumb: string
    md5?: string
    token?: string
    key?: string
    encIdx?: string
}

export interface SnsMedia {
    url: string
    thumb: string
    md5?: string
    token?: string
    key?: string
    encIdx?: string
    livePhoto?: SnsLivePhoto
}

export interface SnsLocation {
    latitude?: number
    longitude?: number
    city?: string
    country?: string
    poiName?: string
    poiAddress?: string
    poiAddressName?: string
    label?: string
}

export interface SnsPost {
    id: string
    tid?: string       // 数据库主键（雪花 ID），用于精确删除
    username: string
    nickname: string
    avatarUrl?: string
    createTime: number
    contentDesc: string
    type?: number
    media: SnsMedia[]
    likes: string[]
    comments: { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string; emojis?: { url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }[] }[]
    location?: SnsLocation
    rawXml?: string
    linkTitle?: string
    linkUrl?: string
}

interface SnsContactIdentity {
    username: string
    wxid: string
    alias?: string
    wechatId?: string
    remark?: string
    nickName?: string
    displayName: string
}

interface ParsedLikeUser {
    username?: string
    nickname?: string
}

interface ParsedCommentItem {
    id: string
    nickname: string
    username?: string
    content: string
    refCommentId: string
    refUsername?: string
    refNickname?: string
    emojis?: { url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }[]
}

interface ArkmeLikeDetail {
    nickname: string
    username?: string
    wxid?: string
    alias?: string
    wechatId?: string
    remark?: string
    nickName?: string
    displayName: string
    source: 'xml' | 'legacy'
}

interface ArkmeCommentDetail {
    id: string
    nickname: string
    username?: string
    wxid?: string
    alias?: string
    wechatId?: string
    remark?: string
    nickName?: string
    displayName: string
    content: string
    refCommentId: string
    refNickname?: string
    refUsername?: string
    refWxid?: string
    refAlias?: string
    refWechatId?: string
    refRemark?: string
    refNickName?: string
    refDisplayName?: string
    emojis?: { url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }[]
    source: 'xml' | 'legacy'
}



const fixSnsUrl = (url: string, token?: string, isVideo: boolean = false) => {
    if (!url) return url

    let fixedUrl = url.replace('http://', 'https://')

    // 只有非视频（即图片）才需要处理 /150 变 /0
    if (!isVideo) {
        fixedUrl = fixedUrl.replace(/\/150($|\?)/, '/0$1')
    }

    if (!token || fixedUrl.includes('token=')) return fixedUrl

    // 根据用户要求，视频链接组合方式为: BASE_URL + "?" + "token=" + token + "&idx=1" + 原有参数
    if (isVideo) {
        const urlParts = fixedUrl.split('?')
        const baseUrl = urlParts[0]
        const existingParams = urlParts[1] ? `&${urlParts[1]}` : ''
        return `${baseUrl}?token=${token}&idx=1${existingParams}`
    }

    const connector = fixedUrl.includes('?') ? '&' : '?'
    return `${fixedUrl}${connector}token=${token}&idx=1`
}

const detectImageMime = (buf: Buffer, fallback: string = 'image/jpeg') => {
    if (!buf || buf.length < 4) return fallback

    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'

    // PNG
    if (
        buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    ) return 'image/png'

    // GIF
    if (buf.length >= 6) {
        const sig = buf.subarray(0, 6).toString('ascii')
        if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif'
    }

    // WebP
    if (
        buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return 'image/webp'

    // BMP
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'

    // MP4: 00 00 00 18 / 20 / ... + 'ftyp'
    if (buf.length > 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4'

    // Fallback logic for video
    if (fallback.includes('video') || fallback.includes('mp4')) return 'video/mp4'

    return fallback
}

export const isVideoUrl = (url: string) => {
    if (!url) return false
    // 排除 vweixinthumb 域名 (缩略图)
    if (url.includes('vweixinthumb')) return false
    return url.includes('snsvideodownload') || url.includes('video') || url.includes('.mp4')
}

import { Isaac64 } from './isaac64'

const extractVideoKey = (xml: string): string | undefined => {
    if (!xml) return undefined
    // 匹配 <enc key="2105122989" ... /> 或 <enc key="2105122989">
    const match = xml.match(/<enc\s+key="(\d+)"/i)
    return match ? match[1] : undefined
}

/**
 * 从 XML 中解析评论信息（含表情包、回复关系）
 */
function parseCommentsFromXml(xml: string): ParsedCommentItem[] {
    if (!xml) return []

    type CommentItem = {
        id: string; nickname: string; username?: string; content: string
        refCommentId: string; refUsername?: string; refNickname?: string
        emojis?: { url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }[]
    }
    const comments: CommentItem[] = []

    try {
        // 支持多种标签格式
        let listMatch = xml.match(/<CommentUserList>([\s\S]*?)<\/CommentUserList>/i)
        if (!listMatch) listMatch = xml.match(/<commentUserList>([\s\S]*?)<\/commentUserList>/i)
        if (!listMatch) listMatch = xml.match(/<commentList>([\s\S]*?)<\/commentList>/i)
        if (!listMatch) listMatch = xml.match(/<comment_user_list>([\s\S]*?)<\/comment_user_list>/i)
        if (!listMatch) return comments

        const listXml = listMatch[1]
        const itemRegex = /<(?:CommentUser|commentUser|comment|user_comment)>([\s\S]*?)<\/(?:CommentUser|commentUser|comment|user_comment)>/gi
        let m: RegExpExecArray | null

        while ((m = itemRegex.exec(listXml)) !== null) {
            const c = m[1]

            const idMatch = c.match(/<(?:cmtid|commentId|comment_id|id)>([^<]*)<\/(?:cmtid|commentId|comment_id|id)>/i)
            const usernameMatch = c.match(/<username>([^<]*)<\/username>/i)
            let nicknameMatch = c.match(/<nickname>([^<]*)<\/nickname>/i)
            if (!nicknameMatch) nicknameMatch = c.match(/<nickName>([^<]*)<\/nickName>/i)
            const contentMatch = c.match(/<content>([^<]*)<\/content>/i)
            const refIdMatch = c.match(/<(?:refCommentId|replyCommentId|ref_comment_id)>([^<]*)<\/(?:refCommentId|replyCommentId|ref_comment_id)>/i)
            const refNickMatch = c.match(/<(?:refNickname|refNickName|replyNickname)>([^<]*)<\/(?:refNickname|refNickName|replyNickname)>/i)
            const refUserMatch = c.match(/<ref_username>([^<]*)<\/ref_username>/i)

            // 解析表情包
            const emojis: { url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }[] = []
            const emojiRegex = /<emojiinfo>([\s\S]*?)<\/emojiinfo>/gi
            let em: RegExpExecArray | null
            while ((em = emojiRegex.exec(c)) !== null) {
                const ex = em[1]
                const externUrl = ex.match(/<extern_url>([^<]*)<\/extern_url>/i)
                const cdnUrl = ex.match(/<cdn_url>([^<]*)<\/cdn_url>/i)
                const plainUrl = ex.match(/<url>([^<]*)<\/url>/i)
                const urlMatch = externUrl || cdnUrl || plainUrl
                const md5Match = ex.match(/<md5>([^<]*)<\/md5>/i)
                const wMatch = ex.match(/<width>([^<]*)<\/width>/i)
                const hMatch = ex.match(/<height>([^<]*)<\/height>/i)
                const encMatch = ex.match(/<encrypt_url>([^<]*)<\/encrypt_url>/i)
                const aesMatch = ex.match(/<aes_key>([^<]*)<\/aes_key>/i)

                const url = urlMatch ? urlMatch[1].trim().replace(/&amp;/g, '&') : ''
                const encryptUrl = encMatch ? encMatch[1].trim().replace(/&amp;/g, '&') : undefined
                const aesKey = aesMatch ? aesMatch[1].trim() : undefined

                if (url || encryptUrl) {
                    emojis.push({
                        url,
                        md5: md5Match ? md5Match[1].trim() : '',
                        width: wMatch ? parseInt(wMatch[1]) : 0,
                        height: hMatch ? parseInt(hMatch[1]) : 0,
                        encryptUrl,
                        aesKey
                    })
                }
            }

            if (nicknameMatch && (contentMatch || emojis.length > 0)) {
                const refId = refIdMatch ? refIdMatch[1].trim() : ''
                comments.push({
                    id: idMatch ? idMatch[1].trim() : `cmt_${Date.now()}_${Math.random()}`,
                    nickname: nicknameMatch[1].trim(),
                    username: usernameMatch ? usernameMatch[1].trim() : undefined,
                    content: contentMatch ? contentMatch[1].trim() : '',
                    refCommentId: refId === '0' ? '' : refId,
                    refUsername: refUserMatch ? refUserMatch[1].trim() : undefined,
                    refNickname: refNickMatch ? refNickMatch[1].trim() : undefined,
                    emojis: emojis.length > 0 ? emojis : undefined
                })
            }
        }

        // 二次解析：通过 refUsername 补全 refNickname
        const userMap = new Map<string, string>()
        for (const c of comments) {
            if (c.username && c.nickname) userMap.set(c.username, c.nickname)
        }
        for (const c of comments) {
            if (!c.refNickname && c.refUsername && c.refCommentId) {
                c.refNickname = userMap.get(c.refUsername)
            }
        }
    } catch (e) {
        console.error('[SnsService] parseCommentsFromXml 失败:', e)
    }

    return comments
}

const decodeXmlText = (text: string): string => {
    if (!text) return ''
    return text
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
}

class SnsService {
    private configService: ConfigService
    private contactCache: ContactCacheService
    private imageCache = new Map<string, string>()
    private exportStatsCache: { totalPosts: number; totalFriends: number; myPosts: number | null; updatedAt: number } | null = null
    private userPostCountsCache: { counts: Record<string, number>; updatedAt: number } | null = null
    private readonly exportStatsCacheTtlMs = 5 * 60 * 1000
    private readonly userPostCountsCacheTtlMs = 5 * 60 * 1000
    private lastTimelineFallbackAt = 0
    private readonly timelineFallbackCooldownMs = 3 * 60 * 1000

    constructor() {
        this.configService = new ConfigService()
        this.contactCache = new ContactCacheService(this.configService.get('cachePath') as string)
    }

    private toOptionalString(value: unknown): string | undefined {
        if (typeof value !== 'string') return undefined
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : undefined
    }

    private async resolveContactIdentity(
        username: string,
        identityCache: Map<string, Promise<SnsContactIdentity | null>>
    ): Promise<SnsContactIdentity | null> {
        const normalized = String(username || '').trim()
        if (!normalized) return null

        let pending = identityCache.get(normalized)
        if (!pending) {
            pending = (async () => {
                const cached = this.contactCache.get(normalized)
                let alias: string | undefined
                let remark: string | undefined
                let nickName: string | undefined

                try {
                    const contactResult = await wcdbService.getContact(normalized)
                    if (contactResult.success && contactResult.contact) {
                        const contact = contactResult.contact
                        alias = this.toOptionalString(contact.alias ?? contact.Alias)
                        remark = this.toOptionalString(contact.remark ?? contact.Remark)
                        nickName = this.toOptionalString(contact.nickName ?? contact.nick_name ?? contact.nickname ?? contact.NickName)
                    }
                } catch {
                    // 联系人补全失败不影响导出
                }

                const displayName = remark || nickName || alias || cached?.displayName || normalized
                return {
                    username: normalized,
                    wxid: normalized,
                    alias,
                    wechatId: alias,
                    remark,
                    nickName,
                    displayName
                }
            })()
            identityCache.set(normalized, pending)
        }

        return pending
    }

    private parseLikeUsersFromXml(xml: string): ParsedLikeUser[] {
        if (!xml) return []
        const likes: ParsedLikeUser[] = []
        try {
            let likeListMatch = xml.match(/<LikeUserList>([\s\S]*?)<\/LikeUserList>/i)
            if (!likeListMatch) likeListMatch = xml.match(/<likeUserList>([\s\S]*?)<\/likeUserList>/i)
            if (!likeListMatch) likeListMatch = xml.match(/<likeList>([\s\S]*?)<\/likeList>/i)
            if (!likeListMatch) likeListMatch = xml.match(/<like_user_list>([\s\S]*?)<\/like_user_list>/i)
            if (!likeListMatch) return likes

            const likeUserRegex = /<(?:LikeUser|likeUser|user_comment)>([\s\S]*?)<\/(?:LikeUser|likeUser|user_comment)>/gi
            let m: RegExpExecArray | null
            while ((m = likeUserRegex.exec(likeListMatch[1])) !== null) {
                const block = m[1]
                const username = this.toOptionalString(block.match(/<username>([^<]*)<\/username>/i)?.[1])
                const nickname = this.toOptionalString(
                    block.match(/<nickname>([^<]*)<\/nickname>/i)?.[1]
                    || block.match(/<nickName>([^<]*)<\/nickName>/i)?.[1]
                )
                if (username || nickname) {
                    likes.push({ username, nickname })
                }
            }
        } catch (e) {
            console.error('[SnsService] 解析点赞用户失败:', e)
        }
        return likes
    }

    private async buildArkmeInteractionDetails(
        post: SnsPost,
        identityCache: Map<string, Promise<SnsContactIdentity | null>>
    ): Promise<{ likesDetail: ArkmeLikeDetail[]; commentsDetail: ArkmeCommentDetail[] }> {
        const xmlLikes = this.parseLikeUsersFromXml(post.rawXml || '')
        const likeCandidates: ParsedLikeUser[] = xmlLikes.length > 0
            ? xmlLikes
            : (post.likes || []).map((nickname) => ({ nickname }))
        const likeSource: 'xml' | 'legacy' = xmlLikes.length > 0 ? 'xml' : 'legacy'
        const likesDetail: ArkmeLikeDetail[] = []
        const likeSeen = new Set<string>()

        for (const like of likeCandidates) {
            const identity = like.username
                ? await this.resolveContactIdentity(like.username, identityCache)
                : null
            const nickname = like.nickname || identity?.displayName || like.username || ''
            const username = identity?.username || like.username
            const key = `${username || ''}|${nickname}`
            if (likeSeen.has(key)) continue
            likeSeen.add(key)
            likesDetail.push({
                nickname,
                username,
                wxid: username,
                alias: identity?.alias,
                wechatId: identity?.wechatId,
                remark: identity?.remark,
                nickName: identity?.nickName,
                displayName: identity?.displayName || nickname || username || '',
                source: likeSource
            })
        }

        const xmlComments = parseCommentsFromXml(post.rawXml || '')
        const commentMap = new Map<string, SnsPost['comments'][number]>()
        for (const comment of post.comments || []) {
            if (comment.id) commentMap.set(comment.id, comment)
        }

        const commentsBase: ParsedCommentItem[] = xmlComments.length > 0
            ? xmlComments.map((comment) => {
                const fallback = comment.id ? commentMap.get(comment.id) : undefined
                return {
                    id: comment.id || fallback?.id || '',
                    nickname: comment.nickname || fallback?.nickname || '',
                    username: comment.username,
                    content: comment.content || fallback?.content || '',
                    refCommentId: comment.refCommentId || fallback?.refCommentId || '',
                    refUsername: comment.refUsername,
                    refNickname: comment.refNickname || fallback?.refNickname,
                    emojis: comment.emojis && comment.emojis.length > 0 ? comment.emojis : fallback?.emojis
                }
            })
            : (post.comments || []).map((comment) => ({
                id: comment.id || '',
                nickname: comment.nickname || '',
                content: comment.content || '',
                refCommentId: comment.refCommentId || '',
                refNickname: comment.refNickname,
                emojis: comment.emojis
            }))

        if (xmlComments.length > 0) {
            const mappedIds = new Set(commentsBase.map((comment) => comment.id).filter(Boolean))
            for (const comment of post.comments || []) {
                if (comment.id && mappedIds.has(comment.id)) continue
                commentsBase.push({
                    id: comment.id || '',
                    nickname: comment.nickname || '',
                    content: comment.content || '',
                    refCommentId: comment.refCommentId || '',
                    refNickname: comment.refNickname,
                    emojis: comment.emojis
                })
            }
        }

        const commentSource: 'xml' | 'legacy' = xmlComments.length > 0 ? 'xml' : 'legacy'
        const commentsDetail: ArkmeCommentDetail[] = []

        for (const comment of commentsBase) {
            const actor = comment.username
                ? await this.resolveContactIdentity(comment.username, identityCache)
                : null
            const refActor = comment.refUsername
                ? await this.resolveContactIdentity(comment.refUsername, identityCache)
                : null
            const nickname = comment.nickname || actor?.displayName || comment.username || ''
            const username = actor?.username || comment.username
            const refUsername = refActor?.username || comment.refUsername
            commentsDetail.push({
                id: comment.id || '',
                nickname,
                username,
                wxid: username,
                alias: actor?.alias,
                wechatId: actor?.wechatId,
                remark: actor?.remark,
                nickName: actor?.nickName,
                displayName: actor?.displayName || nickname || username || '',
                content: comment.content || '',
                refCommentId: comment.refCommentId || '',
                refNickname: comment.refNickname || refActor?.displayName,
                refUsername,
                refWxid: refUsername,
                refAlias: refActor?.alias,
                refWechatId: refActor?.wechatId,
                refRemark: refActor?.remark,
                refNickName: refActor?.nickName,
                refDisplayName: refActor?.displayName,
                emojis: comment.emojis,
                source: commentSource
            })
        }

        return { likesDetail, commentsDetail }
    }

    private parseCountValue(row: any): number {
        if (!row || typeof row !== 'object') return 0
        const raw = row.total ?? row.count ?? row.cnt ?? Object.values(row)[0]
        const num = Number(raw)
        return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0
    }

    private pickTimelineUsername(post: any): string {
        const raw = post?.username ?? post?.user_name ?? post?.userName ?? ''
        if (typeof raw !== 'string') return ''
        return raw.trim()
    }

    private async collectSnsUsernamesFromTimeline(maxRounds: number = 2000): Promise<string[]> {
        const pageSize = 500
        const uniqueUsers = new Set<string>()
        let offset = 0

        for (let round = 0; round < maxRounds; round++) {
            const result = await wcdbService.getSnsTimeline(pageSize, offset, undefined, undefined, 0, 0)
            if (!result.success || !Array.isArray(result.timeline)) {
                throw new Error(result.error || '获取朋友圈发布者失败')
            }

            const rows = result.timeline
            if (rows.length === 0) break

            for (const row of rows) {
                const username = this.pickTimelineUsername(row)
                if (username) uniqueUsers.add(username)
            }

            if (rows.length < pageSize) break
            offset += rows.length
        }

        return Array.from(uniqueUsers)
    }

    private async getExportStatsFromTimeline(myWxid?: string): Promise<{ totalPosts: number; totalFriends: number; myPosts: number | null }> {
        const pageSize = 500
        const uniqueUsers = new Set<string>()
        let totalPosts = 0
        let myPosts = 0
        let offset = 0
        const normalizedMyWxid = this.toOptionalString(myWxid)

        for (let round = 0; round < 2000; round++) {
            const result = await wcdbService.getSnsTimeline(pageSize, offset, undefined, undefined, 0, 0)
            if (!result.success || !Array.isArray(result.timeline)) {
                throw new Error(result.error || '获取朋友圈统计失败')
            }

            const rows = result.timeline
            if (rows.length === 0) break

            totalPosts += rows.length
            for (const row of rows) {
                const username = this.pickTimelineUsername(row)
                if (username) uniqueUsers.add(username)
                if (normalizedMyWxid && username === normalizedMyWxid) myPosts += 1
            }

            if (rows.length < pageSize) break
            offset += rows.length
        }

        return {
            totalPosts,
            totalFriends: uniqueUsers.size,
            myPosts: normalizedMyWxid ? myPosts : null
        }
    }

    private parseLikesFromXml(xml: string): string[] {
        if (!xml) return []
        const likes: string[] = []
        try {
            let likeListMatch = xml.match(/<LikeUserList>([\s\S]*?)<\/LikeUserList>/i)
            if (!likeListMatch) likeListMatch = xml.match(/<likeUserList>([\s\S]*?)<\/likeUserList>/i)
            if (!likeListMatch) likeListMatch = xml.match(/<likeList>([\s\S]*?)<\/likeList>/i)
            if (!likeListMatch) likeListMatch = xml.match(/<like_user_list>([\s\S]*?)<\/like_user_list>/i)
            if (!likeListMatch) return likes

            const likeUserRegex = /<(?:LikeUser|likeUser|user_comment)>([\s\S]*?)<\/(?:LikeUser|likeUser|user_comment)>/gi
            let m: RegExpExecArray | null
            while ((m = likeUserRegex.exec(likeListMatch[1])) !== null) {
                let nick = m[1].match(/<nickname>([^<]*)<\/nickname>/i)
                if (!nick) nick = m[1].match(/<nickName>([^<]*)<\/nickName>/i)
                if (nick) likes.push(nick[1].trim())
            }
        } catch (e) {
            console.error('[SnsService] 解析点赞失败:', e)
        }
        return likes
    }

    private parseMediaFromXml(xml: string): { media: SnsMedia[]; videoKey?: string } {
        if (!xml) return { media: [] }
        const media: SnsMedia[] = []
        let videoKey: string | undefined
        try {
            const encMatch = xml.match(/<enc\s+key="(\d+)"/i)
            if (encMatch) videoKey = encMatch[1]

            const mediaRegex = /<media>([\s\S]*?)<\/media>/gi
            let mediaMatch: RegExpExecArray | null
            while ((mediaMatch = mediaRegex.exec(xml)) !== null) {
                const mx = mediaMatch[1]
                const urlMatch = mx.match(/<url[^>]*>([^<]+)<\/url>/i)
                const urlTagMatch = mx.match(/<url([^>]*)>/i)
                const thumbMatch = mx.match(/<thumb[^>]*>([^<]+)<\/thumb>/i)
                const thumbTagMatch = mx.match(/<thumb([^>]*)>/i)

                let urlToken: string | undefined, urlKey: string | undefined
                let urlMd5: string | undefined, urlEncIdx: string | undefined
                if (urlTagMatch?.[1]) {
                    const a = urlTagMatch[1]
                    urlToken = a.match(/token="([^"]+)"/i)?.[1]
                    urlKey = a.match(/key="([^"]+)"/i)?.[1]
                    urlMd5 = a.match(/md5="([^"]+)"/i)?.[1]
                    urlEncIdx = a.match(/enc_idx="([^"]+)"/i)?.[1]
                }
                let thumbToken: string | undefined, thumbKey: string | undefined, thumbEncIdx: string | undefined
                if (thumbTagMatch?.[1]) {
                    const a = thumbTagMatch[1]
                    thumbToken = a.match(/token="([^"]+)"/i)?.[1]
                    thumbKey = a.match(/key="([^"]+)"/i)?.[1]
                    thumbEncIdx = a.match(/enc_idx="([^"]+)"/i)?.[1]
                }

                const item: SnsMedia = {
                    url: urlMatch ? urlMatch[1].trim() : '',
                    thumb: thumbMatch ? thumbMatch[1].trim() : '',
                    token: urlToken || thumbToken,
                    key: urlKey || thumbKey,
                    md5: urlMd5,
                    encIdx: urlEncIdx || thumbEncIdx
                }

                const livePhotoMatch = mx.match(/<livePhoto>([\s\S]*?)<\/livePhoto>/i)
                if (livePhotoMatch) {
                    const lx = livePhotoMatch[1]
                    const lpUrl = lx.match(/<url[^>]*>([^<]+)<\/url>/i)
                    const lpUrlTag = lx.match(/<url([^>]*)>/i)
                    const lpThumb = lx.match(/<thumb[^>]*>([^<]+)<\/thumb>/i)
                    const lpThumbTag = lx.match(/<thumb([^>]*)>/i)
                    let lpToken: string | undefined, lpKey: string | undefined, lpEncIdx: string | undefined
                    if (lpUrlTag?.[1]) {
                        const a = lpUrlTag[1]
                        lpToken = a.match(/token="([^"]+)"/i)?.[1]
                        lpKey = a.match(/key="([^"]+)"/i)?.[1]
                        lpEncIdx = a.match(/enc_idx="([^"]+)"/i)?.[1]
                    }
                    if (!lpToken && lpThumbTag?.[1]) lpToken = lpThumbTag[1].match(/token="([^"]+)"/i)?.[1]
                    if (!lpKey && lpThumbTag?.[1]) lpKey = lpThumbTag[1].match(/key="([^"]+)"/i)?.[1]
                    item.livePhoto = {
                        url: lpUrl ? lpUrl[1].trim() : '',
                        thumb: lpThumb ? lpThumb[1].trim() : '',
                        token: lpToken,
                        key: lpKey,
                        encIdx: lpEncIdx
                    }
                }
                media.push(item)
            }
        } catch (e) {
            console.error('[SnsService] 解析媒体 XML 失败:', e)
        }
        return { media, videoKey }
    }

    private toOptionalNumber(value: unknown): number | undefined {
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value !== 'string') return undefined
        const trimmed = value.trim()
        if (!trimmed) return undefined
        const parsed = Number.parseFloat(trimmed)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    private normalizeLocation(input: unknown): SnsLocation | undefined {
        if (!input || typeof input !== 'object') return undefined

        const row = input as Record<string, unknown>
        const normalizeText = (value: unknown): string | undefined => {
            if (typeof value !== 'string') return undefined
            return this.toOptionalString(decodeXmlText(value))
        }

        const location: SnsLocation = {}
        const latitude = this.toOptionalNumber(row.latitude ?? row.lat ?? row.x)
        const longitude = this.toOptionalNumber(row.longitude ?? row.lng ?? row.y)
        const city = normalizeText(row.city)
        const country = normalizeText(row.country)
        const poiName = normalizeText(row.poiName ?? row.poiname)
        const poiAddress = normalizeText(row.poiAddress ?? row.poiaddress)
        const poiAddressName = normalizeText(row.poiAddressName ?? row.poiaddressname)
        const label = normalizeText(row.label)

        if (latitude !== undefined) location.latitude = latitude
        if (longitude !== undefined) location.longitude = longitude
        if (city) location.city = city
        if (country) location.country = country
        if (poiName) location.poiName = poiName
        if (poiAddress) location.poiAddress = poiAddress
        if (poiAddressName) location.poiAddressName = poiAddressName
        if (label) location.label = label

        return Object.keys(location).length > 0 ? location : undefined
    }

    private parseLocationFromXml(xml: string): SnsLocation | undefined {
        if (!xml) return undefined

        try {
            const locationTagMatch = xml.match(/<location\b([^>]*)>/i)
            const locationAttrs = locationTagMatch?.[1] || ''
            const readAttr = (name: string): string | undefined => {
                if (!locationAttrs) return undefined
                const match = locationAttrs.match(new RegExp(`${name}\\s*=\\s*["']([\\s\\S]*?)["']`, 'i'))
                if (!match?.[1]) return undefined
                return this.toOptionalString(decodeXmlText(match[1]))
            }
            const readTag = (name: string): string | undefined => {
                const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'))
                if (!match?.[1]) return undefined
                return this.toOptionalString(decodeXmlText(match[1]))
            }

            const location: SnsLocation = {}
            const latitude = this.toOptionalNumber(readAttr('latitude') || readAttr('x') || readTag('latitude') || readTag('x'))
            const longitude = this.toOptionalNumber(readAttr('longitude') || readAttr('y') || readTag('longitude') || readTag('y'))
            const city = readAttr('city') || readTag('city')
            const country = readAttr('country') || readTag('country')
            const poiName = readAttr('poiName') || readAttr('poiname') || readTag('poiName') || readTag('poiname')
            const poiAddress = readAttr('poiAddress') || readAttr('poiaddress') || readTag('poiAddress') || readTag('poiaddress')
            const poiAddressName = readAttr('poiAddressName') || readAttr('poiaddressname') || readTag('poiAddressName') || readTag('poiaddressname')
            const label = readAttr('label') || readTag('label')

            if (latitude !== undefined) location.latitude = latitude
            if (longitude !== undefined) location.longitude = longitude
            if (city) location.city = city
            if (country) location.country = country
            if (poiName) location.poiName = poiName
            if (poiAddress) location.poiAddress = poiAddress
            if (poiAddressName) location.poiAddressName = poiAddressName
            if (label) location.label = label

            return Object.keys(location).length > 0 ? location : undefined
        } catch (e) {
            console.error('[SnsService] 解析位置 XML 失败:', e)
            return undefined
        }
    }

    private mergeLocation(primary?: SnsLocation, fallback?: SnsLocation): SnsLocation | undefined {
        if (!primary && !fallback) return undefined

        const merged: SnsLocation = {}
        const setValue = <K extends keyof SnsLocation>(key: K, value: SnsLocation[K] | undefined) => {
            if (value !== undefined) merged[key] = value
        }

        setValue('latitude', primary?.latitude ?? fallback?.latitude)
        setValue('longitude', primary?.longitude ?? fallback?.longitude)
        setValue('city', primary?.city ?? fallback?.city)
        setValue('country', primary?.country ?? fallback?.country)
        setValue('poiName', primary?.poiName ?? fallback?.poiName)
        setValue('poiAddress', primary?.poiAddress ?? fallback?.poiAddress)
        setValue('poiAddressName', primary?.poiAddressName ?? fallback?.poiAddressName)
        setValue('label', primary?.label ?? fallback?.label)

        return Object.keys(merged).length > 0 ? merged : undefined
    }

    private getSnsCacheDir(): string {
        const configuredCachePath = String(this.configService.get('cachePath') || '').trim()
        const baseDir = configuredCachePath || join(app.getPath('documents'), 'WeFlow')
        const snsCacheDir = join(baseDir, 'sns_cache')
        if (!existsSync(snsCacheDir)) {
            mkdirSync(snsCacheDir, { recursive: true })
        }
        return snsCacheDir
    }

    private getEmojiCacheDir(): string {
        const configuredCachePath = String(this.configService.get('cachePath') || '').trim()
        const baseDir = configuredCachePath || join(app.getPath('documents'), 'WeFlow')
        const emojiDir = join(baseDir, 'Emojis')
        if (!existsSync(emojiDir)) {
            mkdirSync(emojiDir, { recursive: true })
        }
        return emojiDir
    }

    private getCacheFilePath(url: string): string {
        const hash = crypto.createHash('md5').update(url).digest('hex')
        const ext = isVideoUrl(url) ? '.mp4' : '.jpg'
        return join(this.getSnsCacheDir(), `${hash}${ext}`)
    }

    async getSnsUsernames(): Promise<{ success: boolean; usernames?: string[]; error?: string }> {
        const result = await wcdbService.getSnsUsernames()
        if (!result.success) {
            return { success: false, error: result.error || '获取朋友圈联系人失败' }
        }
        const directUsernames = Array.isArray(result.usernames) ? result.usernames : []
        if (directUsernames.length > 0) {
            return { success: true, usernames: directUsernames }
        }

        // 回退：通过 timeline 分页拉取收集用户名，兼容底层接口暂时返回空数组的场景。
        try {
            const timelineUsers = await this.collectSnsUsernamesFromTimeline()
            if (timelineUsers.length > 0) {
                return { success: true, usernames: timelineUsers }
            }
        } catch {
            // 忽略回退错误，保持与原行为一致返回空数组
        }

        return { success: true, usernames: directUsernames }
    }

    private async getExportStatsFromTableCount(myWxid?: string): Promise<{ totalPosts: number; totalFriends: number; myPosts: number | null }> {
        const normalizedMyWxid = this.toOptionalString(myWxid)
        const result = await wcdbService.getSnsExportStats(normalizedMyWxid || undefined)
        if (!result.success || !result.data) {
            return { totalPosts: 0, totalFriends: 0, myPosts: normalizedMyWxid ? 0 : null }
        }
        return {
            totalPosts: Number(result.data.totalPosts || 0),
            totalFriends: Number(result.data.totalFriends || 0),
            myPosts: result.data.myPosts === null || result.data.myPosts === undefined ? null : Number(result.data.myPosts || 0)
        }
    }

    async getExportStats(options?: {
        allowTimelineFallback?: boolean
        preferCache?: boolean
    }): Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }> {
        const allowTimelineFallback = options?.allowTimelineFallback ?? true
        const preferCache = options?.preferCache ?? false
        const now = Date.now()
        const myWxid = this.toOptionalString(this.configService.get('myWxid'))

        try {
            if (preferCache && this.exportStatsCache && now - this.exportStatsCache.updatedAt <= this.exportStatsCacheTtlMs) {
                return {
                    success: true,
                    data: {
                        totalPosts: this.exportStatsCache.totalPosts,
                        totalFriends: this.exportStatsCache.totalFriends,
                        myPosts: this.exportStatsCache.myPosts
                    }
                }
            }

            let { totalPosts, totalFriends, myPosts } = await this.getExportStatsFromTableCount(myWxid)
            let fallbackAttempted = false
            let fallbackError = ''

            // 某些环境下 SnsTimeLine 统计查询会返回 0，这里在允许时回退到与导出同源的 timeline 接口统计。
            if (
                allowTimelineFallback &&
                (totalPosts <= 0 || totalFriends <= 0) &&
                now - this.lastTimelineFallbackAt >= this.timelineFallbackCooldownMs
            ) {
                fallbackAttempted = true
                try {
                    const timelineStats = await this.getExportStatsFromTimeline(myWxid)
                    this.lastTimelineFallbackAt = Date.now()
                    if (timelineStats.totalPosts > 0) {
                        totalPosts = timelineStats.totalPosts
                    }
                    if (timelineStats.totalFriends > 0) {
                        totalFriends = timelineStats.totalFriends
                    }
                    if (timelineStats.myPosts !== null) {
                        myPosts = timelineStats.myPosts
                    }
                } catch (error) {
                    fallbackError = String(error)
                    console.error('[SnsService] getExportStats timeline fallback failed:', error)
                }
            }

            const normalizedStats = {
                totalPosts: Math.max(0, Number(totalPosts || 0)),
                totalFriends: Math.max(0, Number(totalFriends || 0)),
                myPosts: myWxid
                    ? (myPosts === null ? null : Math.max(0, Number(myPosts || 0)))
                    : null
            }
            const computedHasData = normalizedStats.totalPosts > 0 || normalizedStats.totalFriends > 0
            const cacheHasData = !!this.exportStatsCache && (this.exportStatsCache.totalPosts > 0 || this.exportStatsCache.totalFriends > 0)

            // 计算结果全 0 时，优先使用已有非零缓存，避免瞬时异常覆盖有效统计。
            if (!computedHasData && cacheHasData && this.exportStatsCache) {
                return {
                    success: true,
                    data: {
                        totalPosts: this.exportStatsCache.totalPosts,
                        totalFriends: this.exportStatsCache.totalFriends,
                        myPosts: this.exportStatsCache.myPosts
                    }
                }
            }

            // 当主查询结果全 0 且回退统计执行失败时，返回失败给前端显示明确状态（而非错误地展示 0）。
            if (!computedHasData && fallbackAttempted && fallbackError) {
                return { success: false, error: fallbackError }
            }

            this.exportStatsCache = {
                totalPosts: normalizedStats.totalPosts,
                totalFriends: normalizedStats.totalFriends,
                myPosts: normalizedStats.myPosts,
                updatedAt: Date.now()
            }

            return { success: true, data: normalizedStats }
        } catch (e) {
            if (this.exportStatsCache) {
                return {
                    success: true,
                    data: {
                        totalPosts: this.exportStatsCache.totalPosts,
                        totalFriends: this.exportStatsCache.totalFriends,
                        myPosts: this.exportStatsCache.myPosts
                    }
                }
            }
            return { success: false, error: String(e) }
        }
    }

    async getExportStatsFast(): Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }> {
        return this.getExportStats({
            allowTimelineFallback: false,
            preferCache: true
        })
    }

    private async getUserPostCountsFromTimeline(): Promise<Record<string, number>> {
        const pageSize = 500
        const counts: Record<string, number> = {}
        let offset = 0

        for (let round = 0; round < 2000; round++) {
            const result = await wcdbService.getSnsTimeline(pageSize, offset, undefined, undefined, 0, 0)
            if (!result.success || !Array.isArray(result.timeline)) {
                throw new Error(result.error || '获取朋友圈用户总条数失败')
            }

            const rows = result.timeline
            if (rows.length === 0) break

            for (const row of rows) {
                const username = this.pickTimelineUsername(row)
                if (!username) continue
                counts[username] = (counts[username] || 0) + 1
            }

            if (rows.length < pageSize) break
            offset += rows.length
        }

        return counts
    }

    async getUserPostCounts(options?: {
        preferCache?: boolean
    }): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
        const preferCache = options?.preferCache ?? true
        const now = Date.now()

        try {
            if (
                preferCache &&
                this.userPostCountsCache &&
                now - this.userPostCountsCache.updatedAt <= this.userPostCountsCacheTtlMs
            ) {
                return { success: true, counts: this.userPostCountsCache.counts }
            }

            const counts = await this.getUserPostCountsFromTimeline()
            this.userPostCountsCache = {
                counts,
                updatedAt: Date.now()
            }
            return { success: true, counts }
        } catch (error) {
            console.error('[SnsService] getUserPostCounts failed:', error)
            if (this.userPostCountsCache) {
                return { success: true, counts: this.userPostCountsCache.counts }
            }
            return { success: false, error: String(error) }
        }
    }

    async getUserPostStats(username: string): Promise<{ success: boolean; data?: { username: string; totalPosts: number }; error?: string }> {
        const normalizedUsername = this.toOptionalString(username)
        if (!normalizedUsername) {
            return { success: false, error: '用户名不能为空' }
        }

        const countsResult = await this.getUserPostCounts({ preferCache: true })
        if (countsResult.success) {
            const totalPosts = countsResult.counts?.[normalizedUsername] ?? 0
            return {
                success: true,
                data: {
                    username: normalizedUsername,
                    totalPosts: Math.max(0, Number(totalPosts || 0))
                }
            }
        }

        return { success: false, error: countsResult.error || '统计单个好友朋友圈失败' }
    }

    // 安装朋友圈删除拦截
    async installSnsBlockDeleteTrigger(): Promise<{ success: boolean; alreadyInstalled?: boolean; error?: string }> {
        return wcdbService.installSnsBlockDeleteTrigger()
    }

    // 卸载朋友圈删除拦截
    async uninstallSnsBlockDeleteTrigger(): Promise<{ success: boolean; error?: string }> {
        return wcdbService.uninstallSnsBlockDeleteTrigger()
    }

    // 查询朋友圈删除拦截是否已安装
    async checkSnsBlockDeleteTrigger(): Promise<{ success: boolean; installed?: boolean; error?: string }> {
        return wcdbService.checkSnsBlockDeleteTrigger()
    }

    // 从数据库直接删除朋友圈记录
    async deleteSnsPost(postId: string): Promise<{ success: boolean; error?: string }> {
        const result = await wcdbService.deleteSnsPost(postId)
        if (result.success) {
            this.userPostCountsCache = null
            this.exportStatsCache = null
        }
        return result
    }

    /**
     * 补全数据服务返回的评论中缺失的 refNickname
     *数据服务返回的 refCommentId 是被回复评论的 cmtid
     * 评论按 cmtid 从小到大排列，cmtid 从 1 开始递增
     */
    private fixCommentRefs(comments: any[]): any[] {
        if (!comments || comments.length === 0) return []

        //数据服务现在返回完整的评论数据（含 emojis、refNickname）
        // 此处做最终的格式化和兜底补全
        const idToNickname = new Map<string, string>()
        comments.forEach((c, idx) => {
            if (c.id) idToNickname.set(c.id, c.nickname || '')
            // 兜底：按索引映射（部分旧数据 id 可能为空）
            idToNickname.set(String(idx + 1), c.nickname || '')
        })

        return comments.map((c) => {
            const refId = c.refCommentId
            let refNickname = c.refNickname || ''

            if (refId && refId !== '0' && refId !== '' && !refNickname) {
                refNickname = idToNickname.get(refId) || ''
            }

            // 处理 emojis：过滤掉空的 url 和 encryptUrl
            const emojis = (c.emojis || [])
                .filter((e: any) => e.url || e.encryptUrl)
                .map((e: any) => ({
                    url: (e.url || '').replace(/&amp;/g, '&'),
                    md5: e.md5 || '',
                    width: e.width || 0,
                    height: e.height || 0,
                    encryptUrl: e.encryptUrl ? e.encryptUrl.replace(/&amp;/g, '&') : undefined,
                    aesKey: e.aesKey || undefined
                }))

            return {
                id: c.id || '',
                nickname: c.nickname || '',
                content: c.content || '',
                refCommentId: (refId === '0') ? '' : (refId || ''),
                refNickname,
                emojis: emojis.length > 0 ? emojis : undefined
            }
        })
    }

    async getTimeline(limit: number = 20, offset: number = 0, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: SnsPost[]; error?: string }> {
        const result = await wcdbService.getSnsTimeline(limit, offset, usernames, keyword, startTime, endTime)
        if (!result.success || !result.timeline || result.timeline.length === 0) return result

        const enrichedTimeline = result.timeline.map((post: any) => {
            const contact = this.contactCache.get(post.username)
            const isVideoPost = post.type === 15
            const rawXml = post.rawXml || ''
            const videoKey = extractVideoKey(rawXml)
            const location = this.mergeLocation(
                this.normalizeLocation((post as { location?: unknown }).location),
                this.parseLocationFromXml(rawXml)
            )

            const fixedMedia = (post.media || []).map((m: any) => ({
                url: fixSnsUrl(m.url, m.token, isVideoPost),
                thumb: fixSnsUrl(m.thumb, m.token, false),
                md5: m.md5,
                token: m.token,
                key: isVideoPost ? (videoKey || m.key) : m.key,
                encIdx: m.encIdx || m.enc_idx,
                livePhoto: m.livePhoto ? {
                    ...m.livePhoto,
                    url: fixSnsUrl(m.livePhoto.url, m.livePhoto.token, true),
                    thumb: fixSnsUrl(m.livePhoto.thumb, m.livePhoto.token, false),
                    token: m.livePhoto.token,
                    key: videoKey || m.livePhoto.key || m.key,
                    encIdx: m.livePhoto.encIdx || m.livePhoto.enc_idx
                } : undefined
            }))

            //数据服务已返回完整评论数据（含 emojis、refNickname）
            // 如果数据服务评论缺少表情包信息，回退到从 rawXml 重新解析
            const dllComments: any[] = post.comments || []
            const hasEmojisInDll = dllComments.some((c: any) => c.emojis && c.emojis.length > 0)

            let finalComments: any[]
            if (dllComments.length > 0 && (hasEmojisInDll || !rawXml)) {
                //数据服务数据完整，直接使用
                finalComments = this.fixCommentRefs(dllComments)
            } else if (rawXml) {
                // 回退：从 rawXml 重新解析（兼容旧版 DLL）
                const xmlComments = parseCommentsFromXml(rawXml)
                finalComments = xmlComments.length > 0 ? xmlComments : this.fixCommentRefs(dllComments)
            } else {
                finalComments = this.fixCommentRefs(dllComments)
            }

            return {
                ...post,
                avatarUrl: contact?.avatarUrl,
                nickname: post.nickname || contact?.displayName || post.username,
                media: fixedMedia,
                comments: finalComments,
                location
            }
        })

        return { ...result, timeline: enrichedTimeline }
    }

    async debugResource(url: string): Promise<{ success: boolean; status?: number; headers?: any; error?: string }> {
        return new Promise((resolve) => {
            try {
                const https = require('https')
                const urlObj = new URL(url)

                const options = {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351',
                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Connection': 'keep-alive',
                        'Range': 'bytes=0-10'
                    }
                }

                const req = https.request(options, (res: any) => {
                    resolve({
                        success: true,
                        status: res.statusCode,
                        headers: {
                            'x-enc': res.headers['x-enc'],
                            'x-time': res.headers['x-time'],
                            'content-length': res.headers['content-length'],
                            'content-type': res.headers['content-type']
                        }
                    })
                    req.destroy()
                })

                req.on('error', (e: any) => resolve({ success: false, error: e.message }))
                req.end()
            } catch (e: any) {
                resolve({ success: false, error: e.message })
            }
        })
    }



    async proxyImage(url: string, key?: string | number): Promise<{ success: boolean; dataUrl?: string; videoPath?: string; error?: string }> {
        if (!url) return { success: false, error: 'url 不能为空' }
        const cacheKey = `${url}|${key ?? ''}`

        if (this.imageCache.has(cacheKey)) {
            return { success: true, dataUrl: this.imageCache.get(cacheKey) }
        }

        const result = await this.fetchAndDecryptImage(url, key)
        if (result.success) {
            // 如果是视频，返回本地文件路径 (需配合 webSecurity: false 或自定义协议)
            if (result.contentType?.startsWith('video/')) {
                // Return cachePath directly for video
                // 注意：fetchAndDecryptImage 需要修改以返回 cachePath
                return { success: true, videoPath: result.cachePath }
            }

            if (result.data && result.contentType) {
                const dataUrl = `data:${result.contentType};base64,${result.data.toString('base64')}`
                this.imageCache.set(cacheKey, dataUrl)
                return { success: true, dataUrl }
            }
        }
        return { success: false, error: result.error }
    }

    async downloadImage(url: string, key?: string | number): Promise<{ success: boolean; data?: Buffer; contentType?: string; cachePath?: string; error?: string }> {
        return this.fetchAndDecryptImage(url, key)
    }

    /**
     * 导出朋友圈动态
     * 支持筛选条件（用户名、关键词）和媒体文件导出
     */
    async exportTimeline(options: {
        outputDir: string
        format: 'json' | 'html' | 'arkmejson'
        usernames?: string[]
        keyword?: string
        exportMedia?: boolean
        exportImages?: boolean
        exportLivePhotos?: boolean
        exportVideos?: boolean
        startTime?: number
        endTime?: number
    }, progressCallback?: (progress: { current: number; total: number; status: string }) => void, control?: {
        shouldPause?: () => boolean
        shouldStop?: () => boolean
    }): Promise<{ success: boolean; filePath?: string; postCount?: number; mediaCount?: number; paused?: boolean; stopped?: boolean; error?: string }> {
        const { outputDir, format, usernames, keyword, startTime, endTime } = options
        const hasExplicitMediaSelection =
            typeof options.exportImages === 'boolean' ||
            typeof options.exportLivePhotos === 'boolean' ||
            typeof options.exportVideos === 'boolean'
        const shouldExportImages = hasExplicitMediaSelection
            ? options.exportImages === true
            : options.exportMedia === true
        const shouldExportLivePhotos = hasExplicitMediaSelection
            ? options.exportLivePhotos === true
            : options.exportMedia === true
        const shouldExportVideos = hasExplicitMediaSelection
            ? options.exportVideos === true
            : options.exportMedia === true
        const shouldExportMedia = shouldExportImages || shouldExportLivePhotos || shouldExportVideos
        const getControlState = (): 'paused' | 'stopped' | null => {
            if (control?.shouldStop?.()) return 'stopped'
            if (control?.shouldPause?.()) return 'paused'
            return null
        }
        const buildInterruptedResult = (state: 'paused' | 'stopped', postCount: number, mediaCount: number) => (
            state === 'stopped'
                ? { success: true, stopped: true, filePath: '', postCount, mediaCount }
                : { success: true, paused: true, filePath: '', postCount, mediaCount }
        )

        try {
            // 确保输出目录存在
            if (!existsSync(outputDir)) {
                mkdirSync(outputDir, { recursive: true })
            }

            // 1. 分页加载全部帖子
            const allPosts: SnsPost[] = []
            const pageSize = 50
            let endTs: number | undefined = endTime  // 使用 endTime 作为分页起始上界
            let hasMore = true

            progressCallback?.({ current: 0, total: 0, status: '正在加载朋友圈数据...' })

            while (hasMore) {
                const controlState = getControlState()
                if (controlState) {
                    return buildInterruptedResult(controlState, allPosts.length, 0)
                }
                const result = await this.getTimeline(pageSize, 0, usernames, keyword, startTime, endTs)
                if (result.success && result.timeline && result.timeline.length > 0) {
                    allPosts.push(...result.timeline)
                    // 下一页的 endTs 为当前最后一条帖子的时间 - 1
                    const lastTs = result.timeline[result.timeline.length - 1].createTime - 1
                    endTs = lastTs
                    hasMore = result.timeline.length >= pageSize
                    // 如果已经低于 startTime，提前终止
                    if (startTime && lastTs < startTime) {
                        hasMore = false
                    }
                    progressCallback?.({ current: allPosts.length, total: 0, status: `已加载 ${allPosts.length} 条动态...` })
                } else {
                    hasMore = false
                }
            }

            if (allPosts.length === 0) {
                return { success: true, filePath: '', postCount: 0, mediaCount: 0 }
            }

            progressCallback?.({ current: 0, total: allPosts.length, status: `共 ${allPosts.length} 条动态，准备导出...` })

            // 2. 如果需要导出媒体，创建 media 子目录并下载
            let mediaCount = 0
            const mediaDir = join(outputDir, 'media')

            if (shouldExportMedia) {
                if (!existsSync(mediaDir)) {
                    mkdirSync(mediaDir, { recursive: true })
                }

                // 收集所有媒体下载任务
                const mediaTasks: Array<{
                    kind: 'image' | 'video' | 'livephoto'
                    media: SnsMedia
                    url: string
                    key?: string
                    postId: string
                    mi: number
                }> = []
                for (const post of allPosts) {
                    post.media.forEach((media, mi) => {
                        const isVideo = isVideoUrl(media.url)
                        if (shouldExportImages && !isVideo && media.url) {
                            mediaTasks.push({
                                kind: 'image',
                                media,
                                url: media.url,
                                key: media.key,
                                postId: post.id,
                                mi
                            })
                        }
                        if (shouldExportVideos && isVideo && media.url) {
                            mediaTasks.push({
                                kind: 'video',
                                media,
                                url: media.url,
                                key: media.key,
                                postId: post.id,
                                mi
                            })
                        }
                        if (shouldExportLivePhotos && media.livePhoto?.url) {
                            mediaTasks.push({
                                kind: 'livephoto',
                                media,
                                url: media.livePhoto.url,
                                key: media.livePhoto.key || media.key,
                                postId: post.id,
                                mi
                            })
                        }
                    })
                }

                // 并发下载（5路）
                let done = 0
                const concurrency = 5
                const runTask = async (task: typeof mediaTasks[0]) => {
                    const { media, postId, mi } = task
                    try {
                        const isVideo = task.kind === 'video' || task.kind === 'livephoto' || isVideoUrl(task.url)
                        const ext = isVideo ? 'mp4' : 'jpg'
                        const suffix = task.kind === 'livephoto' ? '_live' : ''
                        const fileName = `${postId}_${mi}${suffix}.${ext}`
                        const filePath = join(mediaDir, fileName)

                        if (existsSync(filePath)) {
                            if (task.kind === 'livephoto') {
                                if (media.livePhoto) (media.livePhoto as any).localPath = `media/${fileName}`
                            } else {
                                ;(media as any).localPath = `media/${fileName}`
                            }
                            mediaCount++
                        } else {
                            const result = await this.fetchAndDecryptImage(task.url, task.key)
                            if (result.success && result.data) {
                                await writeFile(filePath, result.data)
                                if (task.kind === 'livephoto') {
                                    if (media.livePhoto) (media.livePhoto as any).localPath = `media/${fileName}`
                                } else {
                                    ;(media as any).localPath = `media/${fileName}`
                                }
                                mediaCount++
                            } else if (result.success && result.cachePath) {
                                const cachedData = await readFile(result.cachePath)
                                await writeFile(filePath, cachedData)
                                if (task.kind === 'livephoto') {
                                    if (media.livePhoto) (media.livePhoto as any).localPath = `media/${fileName}`
                                } else {
                                    ;(media as any).localPath = `media/${fileName}`
                                }
                                mediaCount++
                            }
                        }
                    } catch (e) {
                        console.warn(`[SnsExport] 媒体下载失败: ${task.url}`, e)
                    }
                    done++
                    progressCallback?.({ current: done, total: mediaTasks.length, status: `正在下载媒体 (${done}/${mediaTasks.length})...` })
                }

                // 控制并发的执行器
                const queue = [...mediaTasks]
                const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
                    while (queue.length > 0) {
                        const controlState = getControlState()
                        if (controlState) return controlState
                        const task = queue.shift()!
                        await runTask(task)
                    }
                    return null
                })
                const workerResults = await Promise.all(workers)
                const interruptedState = workerResults.find(state => state === 'paused' || state === 'stopped')
                if (interruptedState) {
                    return buildInterruptedResult(interruptedState, allPosts.length, mediaCount)
                }
            }

            // 2.5 下载头像
            const avatarMap = new Map<string, string>()
            if (format === 'html') {
                if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true })
                const uniqueUsers = [...new Map(allPosts.filter(p => p.avatarUrl).map(p => [p.username, p])).values()]
                let avatarDone = 0
                const avatarQueue = [...uniqueUsers]
                const avatarWorkers = Array.from({ length: Math.min(5, avatarQueue.length) }, async () => {
                    while (avatarQueue.length > 0) {
                        const controlState = getControlState()
                        if (controlState) return controlState
                        const post = avatarQueue.shift()!
                        try {
                            const fileName = `avatar_${crypto.createHash('md5').update(post.username).digest('hex').slice(0, 8)}.jpg`
                            const filePath = join(mediaDir, fileName)
                            if (existsSync(filePath)) {
                                avatarMap.set(post.username, `media/${fileName}`)
                            } else {
                                const result = await this.fetchAndDecryptImage(post.avatarUrl!)
                                if (result.success && result.data) {
                                    await writeFile(filePath, result.data)
                                    avatarMap.set(post.username, `media/${fileName}`)
                                }
                            }
                        } catch (e) { /* 头像下载失败不影响导出 */ }
                        avatarDone++
                        progressCallback?.({ current: avatarDone, total: uniqueUsers.length, status: `正在下载头像 (${avatarDone}/${uniqueUsers.length})...` })
                    }
                    return null
                })
                const avatarWorkerResults = await Promise.all(avatarWorkers)
                const interruptedState = avatarWorkerResults.find(state => state === 'paused' || state === 'stopped')
                if (interruptedState) {
                    return buildInterruptedResult(interruptedState, allPosts.length, mediaCount)
                }
            }

            // 3. 生成输出文件
            const finalControlState = getControlState()
            if (finalControlState) {
                return buildInterruptedResult(finalControlState, allPosts.length, mediaCount)
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            let outputFilePath: string

            if (format === 'json') {
                outputFilePath = join(outputDir, `朋友圈导出_${timestamp}.json`)
                const exportData = {
                    exportTime: new Date().toISOString(),
                    totalPosts: allPosts.length,
                    filters: {
                        usernames: usernames || [],
                        keyword: keyword || ''
                    },
                    posts: allPosts.map(p => ({
                        id: p.id,
                        username: p.username,
                        nickname: p.nickname,
                        createTime: p.createTime,
                        createTimeStr: new Date(p.createTime * 1000).toLocaleString('zh-CN'),
                        contentDesc: p.contentDesc,
                        type: p.type,
                        media: p.media.map(m => ({
                            url: m.url,
                            thumb: m.thumb,
                            localPath: (m as any).localPath || undefined
                        })),
                        likes: p.likes,
                        comments: p.comments,
                        location: p.location,
                        linkTitle: (p as any).linkTitle,
                        linkUrl: (p as any).linkUrl
                    }))
                }
                await writeFile(outputFilePath, JSON.stringify(exportData, null, 2), 'utf-8')
            } else if (format === 'arkmejson') {
                outputFilePath = join(outputDir, `朋友圈导出_${timestamp}.json`)
                progressCallback?.({ current: 0, total: allPosts.length, status: '正在构建 ArkmeJSON 数据...' })

                const identityCache = new Map<string, Promise<SnsContactIdentity | null>>()
                const posts: any[] = []
                let built = 0

                for (const post of allPosts) {
                    const controlState = getControlState()
                    if (controlState) {
                        return buildInterruptedResult(controlState, allPosts.length, mediaCount)
                    }

                    const authorIdentity = await this.resolveContactIdentity(post.username, identityCache)
                    const { likesDetail, commentsDetail } = await this.buildArkmeInteractionDetails(post, identityCache)

                    posts.push({
                        id: post.id,
                        username: post.username,
                        nickname: post.nickname,
                        author: authorIdentity
                            ? {
                                ...authorIdentity
                            }
                            : {
                                username: post.username,
                                wxid: post.username,
                                displayName: post.nickname || post.username
                            },
                        createTime: post.createTime,
                        createTimeStr: new Date(post.createTime * 1000).toLocaleString('zh-CN'),
                        contentDesc: post.contentDesc,
                        type: post.type,
                        media: post.media.map(m => ({
                            url: m.url,
                            thumb: m.thumb,
                            localPath: (m as any).localPath || undefined,
                            livePhoto: m.livePhoto ? {
                                url: m.livePhoto.url,
                                thumb: m.livePhoto.thumb,
                                localPath: (m.livePhoto as any).localPath || undefined
                            } : undefined
                        })),
                        likes: post.likes,
                        comments: post.comments,
                        location: post.location,
                        likesDetail,
                        commentsDetail,
                        linkTitle: (post as any).linkTitle,
                        linkUrl: (post as any).linkUrl
                    })

                    built++
                    if (built % 20 === 0 || built === allPosts.length) {
                        progressCallback?.({ current: built, total: allPosts.length, status: `正在构建 ArkmeJSON 数据 (${built}/${allPosts.length})...` })
                    }
                }

                const ownerWxid = this.toOptionalString(this.configService.get('myWxid'))
                const ownerIdentity = ownerWxid
                    ? await this.resolveContactIdentity(ownerWxid, identityCache)
                    : null
                const recordOwner = ownerIdentity
                    ? { ...ownerIdentity }
                    : ownerWxid
                        ? { username: ownerWxid, wxid: ownerWxid, displayName: ownerWxid }
                        : { username: '', wxid: '', displayName: '' }

                const exportData = {
                    exportTime: new Date().toISOString(),
                    format: 'arkmejson',
                    schemaVersion: '1.0.0',
                    recordOwner,
                    mediaSelection: {
                        images: shouldExportImages,
                        livePhotos: shouldExportLivePhotos,
                        videos: shouldExportVideos
                    },
                    totalPosts: allPosts.length,
                    filters: {
                        usernames: usernames || [],
                        keyword: keyword || ''
                    },
                    posts
                }
                await writeFile(outputFilePath, JSON.stringify(exportData, null, 2), 'utf-8')
            } else {
                // HTML 格式
                outputFilePath = join(outputDir, `朋友圈导出_${timestamp}.html`)
                const html = this.generateHtml(allPosts, { usernames, keyword }, avatarMap)
                await writeFile(outputFilePath, html, 'utf-8')
            }

            progressCallback?.({ current: allPosts.length, total: allPosts.length, status: '导出完成！' })

            return { success: true, filePath: outputFilePath, postCount: allPosts.length, mediaCount }
        } catch (e: any) {
            console.error('[SnsExport] 导出失败:', e)
            return { success: false, error: e.message || String(e) }
        }
    }

    /**
     * 生成朋友圈 HTML 导出文件
     */
    private generateHtml(posts: SnsPost[], filters: { usernames?: string[]; keyword?: string }, avatarMap?: Map<string, string>): string {
        const escapeHtml = (str: string) => str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/\n/g, '<br>')

        const formatTime = (ts: number) => {
            const d = new Date(ts * 1000)
            const now = new Date()
            const isCurrentYear = d.getFullYear() === now.getFullYear()
            const pad = (n: number) => String(n).padStart(2, '0')
            const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`
            const m = d.getMonth() + 1, day = d.getDate()
            return isCurrentYear ? `${m}月${day}日 ${timeStr}` : `${d.getFullYear()}年${m}月${day}日 ${timeStr}`
        }

        // 生成头像首字母
        const avatarLetter = (name: string) => {
            const ch = name.charAt(0)
            return escapeHtml(ch || '?')
        }
        const normalizeLocationText = (value?: string): string => (
            decodeXmlText(String(value || '')).replace(/\s+/g, ' ').trim()
        )
        const resolveLocationText = (location?: SnsLocation): string => {
            if (!location) return ''
            const primaryCandidates = [
                normalizeLocationText(location.poiName),
                normalizeLocationText(location.poiAddressName),
                normalizeLocationText(location.label),
                normalizeLocationText(location.poiAddress)
            ].filter(Boolean)
            const primary = primaryCandidates[0] || ''
            const region = [
                normalizeLocationText(location.country),
                normalizeLocationText(location.city)
            ].filter(Boolean).join(' ')
            if (primary && region && !primary.includes(region)) {
                return `${primary} · ${region}`
            }
            return primary || region
        }

        let filterInfo = ''
        if (filters.keyword) filterInfo += `关键词: "${escapeHtml(filters.keyword)}" `
        if (filters.usernames && filters.usernames.length > 0) filterInfo += `筛选用户: ${filters.usernames.length} 人`

        const postsHtml = posts.map(post => {
            const mediaCount = post.media.length
            const gridClass = mediaCount === 1 ? 'grid-1' : mediaCount === 2 || mediaCount === 4 ? 'grid-2' : 'grid-3'

            const mediaHtml = post.media.map((m, mi) => {
                const localPath = (m as any).localPath
                if (localPath) {
                    if (isVideoUrl(m.url)) {
                        return `<div class="mi"><video src="${escapeHtml(localPath)}" controls preload="metadata"></video></div>`
                    }
                    return `<div class="mi"><img src="${escapeHtml(localPath)}" loading="lazy" onclick="openLb(this.src)" alt=""></div>`
                }
                return `<div class="mi ml"><a href="${escapeHtml(m.url)}" target="_blank">查看媒体</a></div>`
            }).join('')

            const linkHtml = post.linkTitle && post.linkUrl
                ? `<a class="lk" href="${escapeHtml(post.linkUrl)}" target="_blank"><span class="lk-t">${escapeHtml(post.linkTitle)}</span><span class="lk-a">›</span></a>`
                : ''
            const locationText = resolveLocationText(post.location)
            const locationHtml = locationText
                ? `<div class="loc"><span class="loc-i">📍</span><span class="loc-t">${escapeHtml(locationText)}</span></div>`
                : ''

            const likesHtml = post.likes.length > 0
                ? `<div class="interactions"><div class="likes">♥ ${post.likes.map(l => `<span>${escapeHtml(l)}</span>`).join('、')}</div></div>`
                : ''

            const commentsHtml = post.comments.length > 0
                ? `<div class="interactions${post.likes.length > 0 ? ' cmt-border' : ''}"><div class="cmts">${post.comments.map(c => {
                    const ref = c.refNickname ? `<span class="re">回复</span><b>${escapeHtml(c.refNickname)}</b>` : ''
                    return `<div class="cmt"><b>${escapeHtml(c.nickname)}</b>${ref}：${escapeHtml(c.content)}</div>`
                }).join('')}</div></div>`
                : ''

            const avatarSrc = avatarMap?.get(post.username)
            const avatarHtml = avatarSrc
                ? `<div class="avatar"><img src="${escapeHtml(avatarSrc)}" alt=""></div>`
                : `<div class="avatar">${avatarLetter(post.nickname)}</div>`

            return `<div class="post">
${avatarHtml}
<div class="body">
<div class="hd"><span class="nick">${escapeHtml(post.nickname)}</span><span class="tm">${formatTime(post.createTime)}</span></div>
${post.contentDesc ? `<div class="txt">${escapeHtml(post.contentDesc)}</div>` : ''}
${locationHtml}
${mediaHtml ? `<div class="mg ${gridClass}">${mediaHtml}</div>` : ''}
${linkHtml}
${likesHtml}
${commentsHtml}
</div></div>`
        }).join('\n')

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>朋友圈导出</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--t1);line-height:1.6;-webkit-font-smoothing:antialiased}
:root{--bg:#F0EEE9;--card:rgba(255,255,255,.92);--t1:#3d3d3d;--t2:#666;--t3:#999;--accent:#8B7355;--border:rgba(0,0,0,.08);--bg3:rgba(0,0,0,.03)}
@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--card:rgba(40,40,40,.85);--t1:#e0e0e0;--t2:#aaa;--t3:#777;--accent:#c4a882;--border:rgba(255,255,255,.1);--bg3:rgba(255,255,255,.06)}}
.container{max-width:800px;margin:0 auto;padding:20px 24px 60px}

/* 页面标题 */
.feed-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 4px}
.feed-hd h2{font-size:20px;font-weight:700}
.feed-hd .info{font-size:12px;color:var(--t3)}

/* 帖子卡片 - 头像+内容双列 */
.post{background:var(--card);border-radius:16px;border:1px solid var(--border);padding:20px;margin-bottom:24px;display:flex;gap:16px;box-shadow:0 2px 8px rgba(0,0,0,.02);transition:transform .2s,box-shadow .2s}
.post:hover{transform:translateY(-2px);box-shadow:0 8px 16px rgba(0,0,0,.06)}
.avatar{width:48px;height:48px;border-radius:12px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;flex-shrink:0;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover}
.body{flex:1;min-width:0}
.hd{display:flex;flex-direction:column;margin-bottom:8px}
.nick{font-size:15px;font-weight:700;color:var(--accent);margin-bottom:2px}
.tm{font-size:12px;color:var(--t3)}
.txt{font-size:15px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin-bottom:12px}
.loc{display:flex;align-items:flex-start;gap:6px;font-size:13px;color:var(--t2);margin:-4px 0 12px}
.loc-i{line-height:1.3}
.loc-t{line-height:1.45;word-break:break-word}

/* 媒体网格 */
.mg{display:grid;gap:6px;margin-bottom:12px;max-width:320px}
.grid-1{max-width:300px}
.grid-1 .mi{border-radius:12px}
.grid-1 .mi img{aspect-ratio:auto;max-height:480px;object-fit:contain;background:var(--bg3)}
.grid-2{grid-template-columns:1fr 1fr}
.grid-3{grid-template-columns:1fr 1fr 1fr}
.mi{overflow:hidden;border-radius:12px;background:var(--bg3);position:relative;aspect-ratio:1}
.mi img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in;transition:opacity .2s}
.mi img:hover{opacity:.9}
.mi video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.ml{display:flex;align-items:center;justify-content:center}
.ml a{color:var(--accent);text-decoration:none;font-size:13px}

/* 链接卡片 */
.lk{display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:12px;text-decoration:none;color:var(--t1);font-size:14px;margin-bottom:12px;transition:background .15s}
.lk:hover{background:var(--border)}
.lk-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.lk-a{color:var(--t3);font-size:18px;flex-shrink:0}

/* 互动区域 */
.interactions{margin-top:12px;padding-top:12px;border-top:1px dashed var(--border);font-size:13px}
.interactions.cmt-border{border-top:none;padding-top:0;margin-top:8px}
.likes{color:var(--accent);font-weight:500;line-height:1.8}
.cmts{background:var(--bg3);border-radius:8px;padding:8px 12px;line-height:1.4}
.cmt{margin-bottom:4px;color:var(--t2)}
.cmt:last-child{margin-bottom:0}
.cmt b{color:var(--accent);font-weight:500}
.re{color:var(--t3);margin:0 4px;font-size:12px}

/* 灯箱 */
.lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out}
.lb.on{display:flex}
.lb img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px}

/* 回到顶部 */
.btt{position:fixed;right:24px;bottom:32px;width:44px;height:44px;border-radius:50%;background:var(--card);box-shadow:0 2px 12px rgba(0,0,0,.12);border:1px solid var(--border);cursor:pointer;font-size:18px;display:none;align-items:center;justify-content:center;z-index:100;color:var(--t2)}
.btt:hover{transform:scale(1.1)}
.btt.show{display:flex}

/* 页脚 */
.ft{text-align:center;padding:32px 0 24px;font-size:12px;color:var(--t3)}
</style>
</head>
<body>
<div class="container">
    <div class="feed-hd"><h2>朋友圈</h2><span class="info">共 ${posts.length} 条${filterInfo ? ` · ${filterInfo}` : ''}</span></div>
    ${postsHtml}
    <div class="ft">由 WeFlow 导出 · ${new Date().toLocaleString('zh-CN')}</div>
</div>
<div class="lb" id="lb" onclick="closeLb()"><img id="lbi" src=""></div>
<button class="btt" id="btt" onclick="scrollTo({top:0,behavior:'smooth'})">↑</button>
<script>
function openLb(s){document.getElementById('lbi').src=s;document.getElementById('lb').classList.add('on');document.body.style.overflow='hidden'}
function closeLb(){document.getElementById('lb').classList.remove('on');document.body.style.overflow=''}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeLb()})
window.addEventListener('scroll',function(){document.getElementById('btt').classList.toggle('show',window.scrollY>600)})
</script>
</body>
</html>`
    }

    private async fetchAndDecryptImage(url: string, key?: string | number): Promise<{ success: boolean; data?: Buffer; contentType?: string; cachePath?: string; error?: string }> {
        if (!url) return { success: false, error: 'url 不能为空' }

        const isVideo = isVideoUrl(url)
        const cachePath = this.getCacheFilePath(url)

        // 1. 优先尝试从当前缓存目录读取
        if (existsSync(cachePath)) {
            try {
                // 对于视频，不读取整个文件到内存，只确认存在即可
                if (isVideo) {
                    return { success: true, cachePath, contentType: 'video/mp4' }
                }

                const data = await readFile(cachePath)
                const contentType = detectImageMime(data)
                return { success: true, data, contentType, cachePath }
            } catch (e) {
                console.warn(`[SnsService] 读取缓存失败: ${cachePath}`, e)
            }
        }

        if (isVideo) {
            // 视频专用下载逻辑 (下载 -> 解密 -> 缓存)
            return new Promise(async (resolve) => {
                const tmpPath = join(require('os').tmpdir(), `sns_video_${Date.now()}_${Math.random().toString(36).slice(2)}.enc`)

                try {
                    const https = require('https')
                    const urlObj = new URL(url)
                    const fs = require('fs')

                    const fileStream = fs.createWriteStream(tmpPath)

                    const options = {
                        hostname: urlObj.hostname,
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'MicroMessenger Client',
                            'Accept': '*/*',
                            // 'Accept-Encoding': 'gzip, deflate, br', // 视频流通常不压缩，去掉以免 stream 处理复杂
                            'Connection': 'keep-alive'
                        }
                    }

                    const req = https.request(options, (res: any) => {
                        if (res.statusCode !== 200 && res.statusCode !== 206) {
                            fileStream.close()
                            fs.unlink(tmpPath, () => { }) // 删除临时文件
                            resolve({ success: false, error: `HTTP ${res.statusCode}` })
                            return
                        }

                        res.pipe(fileStream)
                        fileStream.on('finish', async () => {
                            fileStream.close()

                            try {
                                const encryptedBuffer = await readFile(tmpPath)
                                const raw = encryptedBuffer // 引用，方便后续操作


                                if (key && String(key).trim().length > 0) {
                                    try {
                                        const keyText = String(key).trim()
                                        let keystream: Buffer

                                        try {
                                            const wasmService = WasmService.getInstance()
                                            // 只需要前 128KB (131072 bytes) 用于解密头部
                                            keystream = await wasmService.getKeystream(keyText, 131072)
                                        } catch (wasmErr) {
                                            // 打包漏带 wasm 或 wasm 初始化异常时，回退到纯 TS ISAAC64
                                            const isaac = new Isaac64(keyText)
                                            keystream = isaac.generateKeystreamBE(131072)
                                        }

                                        const decryptLen = Math.min(keystream.length, raw.length)

                                        // XOR 解密
                                        for (let i = 0; i < decryptLen; i++) {
                                            raw[i] ^= keystream[i]
                                        }

                                        // 验证 MP4 签名 ('ftyp' at offset 4)
                                        const ftyp = raw.subarray(4, 8).toString('ascii')
                                        if (ftyp !== 'ftyp') {
                                            // 可以在此处记录解密可能失败的标记，但不打印详细 hex
                                        }
                                    } catch (err) {
                                        console.error(`[SnsService] 视频解密出错: ${err}`)
                                    }
                                }

                                // 写入最终缓存 (覆盖)
                                await writeFile(cachePath, raw)

                                // 删除临时文件
                                try { await import('fs/promises').then(fs => fs.unlink(tmpPath)) } catch (e) { }

                                resolve({ success: true, data: raw, contentType: 'video/mp4', cachePath })
                            } catch (e: any) {
                                console.error(`[SnsService] 视频处理失败:`, e)
                                resolve({ success: false, error: e.message })
                            }
                        })
                    })

                    req.on('error', (e: any) => {
                        fs.unlink(tmpPath, () => { })
                        resolve({ success: false, error: e.message })
                    })

                    req.setTimeout(15000, () => {
                        req.destroy()
                        fs.unlink(tmpPath, () => { })
                        resolve({ success: false, error: '请求超时' })
                    })

                    req.end()

                } catch (e: any) {
                    resolve({ success: false, error: e.message })
                }
            })
        }

        // 图片逻辑 (保持流式处理)
        return new Promise((resolve) => {
            try {
                const https = require('https')
                const zlib = require('zlib')
                const urlObj = new URL(url)

                const options = {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'MicroMessenger Client',
                        'Accept': '*/*',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Connection': 'keep-alive'
                    }
                }

                const req = https.request(options, (res: any) => {
                    if (res.statusCode !== 200 && res.statusCode !== 206) {
                        resolve({ success: false, error: `HTTP ${res.statusCode}` })
                        return
                    }

                    const chunks: Buffer[] = []
                    let stream = res

                    const encoding = res.headers['content-encoding']
                    if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip())
                    else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
                    else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())

                    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
                    stream.on('end', async () => {
                        const raw = Buffer.concat(chunks)
                        const xEnc = String(res.headers['x-enc'] || '').trim()

                        let decoded = raw

                        // 图片逻辑
                        const shouldDecrypt = (xEnc === '1' || !!key) && key !== undefined && key !== null && String(key).trim().length > 0
                        if (shouldDecrypt) {
                            try {
                                const keyStr = String(key).trim()
                                if (/^\d+$/.test(keyStr)) {
                                    // 使用 WASM 版本的 Isaac64 解密图片
                                    // 修正逻辑：使用带 reverse 且修正了 8字节对齐偏移的 getKeystream
                                    const wasmService = WasmService.getInstance()
                                    const keystream = await wasmService.getKeystream(keyStr, raw.length)

                                    const decrypted = Buffer.allocUnsafe(raw.length)
                                    for (let i = 0; i < raw.length; i++) {
                                        decrypted[i] = raw[i] ^ keystream[i]
                                    }

                                    decoded = decrypted
                                }
                            } catch (e) {
                                console.error('[SnsService] TS Decrypt Error:', e)
                            }
                        }

                        // 写入磁盘缓存
                        try {
                            await writeFile(cachePath, decoded)
                        } catch (e) {
                            console.warn(`[SnsService] 写入缓存失败: ${cachePath}`, e)
                        }

                        const contentType = detectImageMime(decoded, (res.headers['content-type'] || 'image/jpeg') as string)
                        resolve({ success: true, data: decoded, contentType, cachePath })
                    })
                    stream.on('error', (e: any) => resolve({ success: false, error: e.message }))
                })

                req.on('error', (e: any) => resolve({ success: false, error: e.message }))
                req.setTimeout(15000, () => {
                    req.destroy()
                    resolve({ success: false, error: '请求超时' })
                })
                req.end()
            } catch (e: any) {
                resolve({ success: false, error: e.message })
            }
        })
    }

    /** 判断 buffer 是否为有效图片头 */
    private isValidImageBuffer(buf: Buffer): boolean {
        if (!buf || buf.length < 12) return false
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
            && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true
        return false
    }

    /** 根据图片头返回扩展名 */
    private getImageExtFromBuffer(buf: Buffer): string {
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png'
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg'
        if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
            && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp'
        return '.gif'
    }

    /** 构建多种密钥派生方式 */
    private buildKeyTries(aesKey: string): { name: string; key: Buffer }[] {
        const keyTries: { name: string; key: Buffer }[] = []
        const hexStr = aesKey.replace(/\s/g, '')
        if (hexStr.length >= 32 && /^[0-9a-fA-F]+$/.test(hexStr)) {
            try {
                const keyBuf = Buffer.from(hexStr.slice(0, 32), 'hex')
                if (keyBuf.length === 16) keyTries.push({ name: 'hex-decode', key: keyBuf })
            } catch { }
            const rawKey = Buffer.from(hexStr.slice(0, 32), 'utf8')
            if (rawKey.length === 32) keyTries.push({ name: 'raw-hex-str-32', key: rawKey })
        }
        if (aesKey.length >= 16) {
            keyTries.push({ name: 'utf8-16', key: Buffer.from(aesKey, 'utf8').subarray(0, 16) })
        }
        keyTries.push({ name: 'md5', key: crypto.createHash('md5').update(aesKey).digest() })
        try {
            const b64Buf = Buffer.from(aesKey, 'base64')
            if (b64Buf.length >= 16) keyTries.push({ name: 'base64', key: b64Buf.subarray(0, 16) })
        } catch { }
        return keyTries
    }

    /** 构建多种 GCM 数据布局 */
    private buildGcmLayouts(encData: Buffer): { nonce: Buffer; ciphertext: Buffer; tag: Buffer }[] {
        const layouts: { nonce: Buffer; ciphertext: Buffer; tag: Buffer }[] = []
        // 格式 A：GcmData 块格式
        if (encData.length > 63 && encData[0] === 0xAB && encData[8] === 0xAB && encData[9] === 0x00) {
            const payloadSize = encData.readUInt32LE(10)
            if (payloadSize > 16 && 63 + payloadSize <= encData.length) {
                const nonce = encData.subarray(19, 31)
                const payload = encData.subarray(63, 63 + payloadSize)
                layouts.push({ nonce, ciphertext: payload.subarray(0, payload.length - 16), tag: payload.subarray(payload.length - 16) })
            }
        }
        // 格式 B：尾部 [ciphertext][nonce 12B][tag 16B]
        if (encData.length > 28) {
            layouts.push({
                ciphertext: encData.subarray(0, encData.length - 28),
                nonce: encData.subarray(encData.length - 28, encData.length - 16),
                tag: encData.subarray(encData.length - 16)
            })
        }
        // 格式 C：前置 [nonce 12B][ciphertext][tag 16B]
        if (encData.length > 28) {
            layouts.push({
                nonce: encData.subarray(0, 12),
                ciphertext: encData.subarray(12, encData.length - 16),
                tag: encData.subarray(encData.length - 16)
            })
        }
        // 格式 D：零 nonce
        if (encData.length > 16) {
            layouts.push({
                nonce: Buffer.alloc(12, 0),
                ciphertext: encData.subarray(0, encData.length - 16),
                tag: encData.subarray(encData.length - 16)
            })
        }
        // 格式 E：[nonce 12B][tag 16B][ciphertext]
        if (encData.length > 28) {
            layouts.push({
                nonce: encData.subarray(0, 12),
                tag: encData.subarray(12, 28),
                ciphertext: encData.subarray(28)
            })
        }
        return layouts
    }

    /** 尝试 AES-GCM 解密 */
    private tryGcmDecrypt(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer | null {
        try {
            const algo = key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm'
            const decipher = crypto.createDecipheriv(algo, key, nonce)
            decipher.setAuthTag(tag)
            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
            if (this.isValidImageBuffer(decrypted)) return decrypted
            for (const fn of [zlib.inflateSync, zlib.gunzipSync, zlib.unzipSync]) {
                try {
                    const d = fn(decrypted)
                    if (this.isValidImageBuffer(d)) return d
                } catch { }
            }
            return decrypted
        } catch {
            return null
        }
    }

    /**
     * 解密表情数据（多种算法 + 多种密钥派生）
     * 移植自 ciphertalk 的逆向实现
     */
    private decryptEmojiAes(encData: Buffer, aesKey: string): Buffer | null {
        if (encData.length <= 16) return null

        const keyTries = this.buildKeyTries(aesKey)
        const tag = encData.subarray(encData.length - 16)
        const ciphertext = encData.subarray(0, encData.length - 16)

        // 最高优先级：nonce-tail 格式 [ciphertext][nonce 12B][tag 16B]
        if (encData.length > 28) {
            const nonceTail = encData.subarray(encData.length - 28, encData.length - 16)
            const tagTail = encData.subarray(encData.length - 16)
            const cipherTail = encData.subarray(0, encData.length - 28)
            for (const { key } of keyTries) {
                if (key.length !== 16 && key.length !== 32) continue
                const result = this.tryGcmDecrypt(key, nonceTail, cipherTail, tagTail)
                if (result) return result
            }
        }

        // 次优先级：nonce = key 前 12 字节
        for (const { key } of keyTries) {
            if (key.length !== 16 && key.length !== 32) continue
            const nonce = key.subarray(0, 12)
            const result = this.tryGcmDecrypt(key, nonce, ciphertext, tag)
            if (result) return result
        }

        // 其他 GCM 布局
        const layouts = this.buildGcmLayouts(encData)
        for (const layout of layouts) {
            for (const { key } of keyTries) {
                if (key.length !== 16 && key.length !== 32) continue
                const result = this.tryGcmDecrypt(key, layout.nonce, layout.ciphertext, layout.tag)
                if (result) return result
            }
        }

        // 回退：AES-128-CBC / AES-128-ECB
        for (const { key } of keyTries) {
            if (key.length !== 16) continue
            // CBC：IV = key
            if (encData.length >= 16 && encData.length % 16 === 0) {
                try {
                    const dec = crypto.createDecipheriv('aes-128-cbc', key, key)
                    dec.setAutoPadding(true)
                    const result = Buffer.concat([dec.update(encData), dec.final()])
                    if (this.isValidImageBuffer(result)) return result
                    for (const fn of [zlib.inflateSync, zlib.gunzipSync]) {
                        try { const d = fn(result); if (this.isValidImageBuffer(d)) return d } catch { }
                    }
                } catch { }
            }
            // CBC：前 16 字节作为 IV
            if (encData.length > 32) {
                try {
                    const iv = encData.subarray(0, 16)
                    const dec = crypto.createDecipheriv('aes-128-cbc', key, iv)
                    dec.setAutoPadding(true)
                    const result = Buffer.concat([dec.update(encData.subarray(16)), dec.final()])
                    if (this.isValidImageBuffer(result)) return result
                } catch { }
            }
            // ECB
            try {
                const dec = crypto.createDecipheriv('aes-128-ecb', key, null)
                dec.setAutoPadding(true)
                const result = Buffer.concat([dec.update(encData), dec.final()])
                if (this.isValidImageBuffer(result)) return result
            } catch { }
        }

        return null
    }

    /** 下载原始数据到本地临时文件，支持重定向 */
    private doDownloadRaw(targetUrl: string, cacheKey: string, cacheDir: string): Promise<string | null> {
        return new Promise((resolve) => {
            try {
                const fs = require('fs')
                const https = require('https')
                const http = require('http')
                let fixedUrl = targetUrl.replace(/&amp;/g, '&')
                const urlObj = new URL(fixedUrl)
                const protocol = fixedUrl.startsWith('https') ? https : http

                const options = {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger/7.0.20.1781(0x67001431)',
                        'Accept': '*/*',
                        'Connection': 'keep-alive'
                    },
                    rejectUnauthorized: false,
                    timeout: 15000
                }

                const request = protocol.get(fixedUrl, options, (response: any) => {
                    // 处理重定向
                    if ([301, 302, 303, 307].includes(response.statusCode)) {
                        const redirectUrl = response.headers.location
                        if (redirectUrl) {
                            const full = redirectUrl.startsWith('http') ? redirectUrl : `${urlObj.protocol}//${urlObj.host}${redirectUrl}`
                            this.doDownloadRaw(full, cacheKey, cacheDir).then(resolve)
                            return
                        }
                    }
                    if (response.statusCode !== 200) { resolve(null); return }

                    const chunks: Buffer[] = []
                    response.on('data', (chunk: Buffer) => chunks.push(chunk))
                    response.on('end', () => {
                        const buffer = Buffer.concat(chunks)
                        if (buffer.length === 0) { resolve(null); return }
                        const ext = this.isValidImageBuffer(buffer) ? this.getImageExtFromBuffer(buffer) : '.bin'
                        const filePath = join(cacheDir, `${cacheKey}${ext}`)
                        try {
                            fs.writeFileSync(filePath, buffer)
                            resolve(filePath)
                        } catch { resolve(null) }
                    })
                    response.on('error', () => resolve(null))
                })
                request.on('error', () => resolve(null))
                request.setTimeout(15000, () => { request.destroy(); resolve(null) })
            } catch { resolve(null) }
        })
    }

    /**
     * 下载朋友圈评论中的表情包（多种解密算法，移植自 ciphertalk）
     */
    async downloadSnsEmoji(url: string, encryptUrl?: string, aesKey?: string): Promise<{ success: boolean; localPath?: string; error?: string }> {
        if (!url && !encryptUrl) return { success: false, error: 'url 不能为空' }

        const fs = require('fs')
        const cacheKey = crypto.createHash('md5').update(url || encryptUrl!).digest('hex')
        const emojiDir = this.getEmojiCacheDir()

        // 检查本地缓存
        for (const ext of ['.gif', '.png', '.webp', '.jpg', '.jpeg']) {
            const filePath = join(emojiDir, `${cacheKey}${ext}`)
            if (existsSync(filePath)) return { success: true, localPath: filePath }
        }

        // 保存解密后的图片
        const saveDecrypted = (buf: Buffer): { success: boolean; localPath?: string } => {
            const ext = this.isValidImageBuffer(buf) ? this.getImageExtFromBuffer(buf) : '.gif'
            const filePath = join(emojiDir, `${cacheKey}${ext}`)
            try { fs.writeFileSync(filePath, buf); return { success: true, localPath: filePath } }
            catch { return { success: false } }
        }

        // 1. 优先：encryptUrl + aesKey
        if (encryptUrl && aesKey) {
            const encResult = await this.doDownloadRaw(encryptUrl, cacheKey + '_enc', emojiDir)
            if (encResult) {
                const encData = fs.readFileSync(encResult)
                if (this.isValidImageBuffer(encData)) {
                    const ext = this.getImageExtFromBuffer(encData)
                    const filePath = join(emojiDir, `${cacheKey}${ext}`)
                    fs.writeFileSync(filePath, encData)
                    try { fs.unlinkSync(encResult) } catch { }
                    return { success: true, localPath: filePath }
                }
                const decrypted = this.decryptEmojiAes(encData, aesKey)
                if (decrypted) {
                    try { fs.unlinkSync(encResult) } catch { }
                    return saveDecrypted(decrypted)
                }
                try { fs.unlinkSync(encResult) } catch { }
            }
        }

        // 2. 直接下载 url
        if (url) {
            const result = await this.doDownloadRaw(url, cacheKey, emojiDir)
            if (result) {
                const buf = fs.readFileSync(result)
                if (this.isValidImageBuffer(buf)) return { success: true, localPath: result }
                // 用 aesKey 解密
                if (aesKey) {
                    const decrypted = this.decryptEmojiAes(buf, aesKey)
                    if (decrypted) {
                        try { fs.unlinkSync(result) } catch { }
                        return saveDecrypted(decrypted)
                    }
                }
                try { fs.unlinkSync(result) } catch { }
            }
        }

        return { success: false, error: '下载表情包失败' }
    }
}

export const snsService = new SnsService()
