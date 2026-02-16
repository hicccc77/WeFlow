import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { ContactCacheService } from './contactCacheService'
import { existsSync, mkdirSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { basename, join } from 'path'
import crypto from 'crypto'
import { WasmService } from './wasmService'

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

export interface SnsPost {
    id: string
    username: string
    nickname: string
    avatarUrl?: string
    createTime: number
    contentDesc: string
    type?: number
    media: SnsMedia[]
    likes: string[]
    comments: { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }[]
    rawXml?: string
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

class SnsService {
    private configService: ConfigService
    private contactCache: ContactCacheService
    private imageCache = new Map<string, string>()

    constructor() {
        this.configService = new ConfigService()
        this.contactCache = new ContactCacheService(this.configService.get('cachePath') as string)
    }

    private getSnsCacheDir(): string {
        const cachePath = this.configService.getCacheBasePath()
        const snsCacheDir = join(cachePath, 'sns_cache')
        if (!existsSync(snsCacheDir)) {
            mkdirSync(snsCacheDir, { recursive: true })
        }
        return snsCacheDir
    }

    private getCacheFilePath(url: string): string {
        const hash = crypto.createHash('md5').update(url).digest('hex')
        const ext = isVideoUrl(url) ? '.mp4' : '.jpg'
        return join(this.getSnsCacheDir(), `${hash}${ext}`)
    }

    async getTimeline(limit: number = 20, offset: number = 0, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: SnsPost[]; error?: string }> {
        const result = await wcdbService.getSnsTimeline(limit, offset, usernames, keyword, startTime, endTime)

        if (result.success && result.timeline) {
            const enrichedTimeline = result.timeline.map((post: any) => {
                const contact = this.contactCache.get(post.username)
                const isVideoPost = post.type === 15

                // 尝试从 rawXml 中提取视频解密密钥 (针对视频号视频)
                const videoKey = extractVideoKey(post.rawXml || '')

                const fixedMedia = (post.media || []).map((m: any) => ({
                    // 如果是视频动态，url 是视频，thumb 是缩略图
                    url: fixSnsUrl(m.url, m.token, isVideoPost),
                    thumb: fixSnsUrl(m.thumb, m.token, false),
                    md5: m.md5,
                    token: m.token,
                    // 只有在视频动态 (Type 15) 下才尝试将 XML 提取的 videoKey 赋予主媒体
                    // 对于图片或实况照片的静态部分，应保留原始 m.key (由 DLL/DB 提供)，避免由于错误的 Isaac64 密钥导致图片解密损坏
                    key: isVideoPost ? (videoKey || m.key) : m.key,
                    encIdx: m.encIdx || m.enc_idx,
                    livePhoto: m.livePhoto
                        ? {
                            ...m.livePhoto,
                            url: fixSnsUrl(m.livePhoto.url, m.livePhoto.token, true),
                            thumb: fixSnsUrl(m.livePhoto.thumb, m.livePhoto.token, false),
                            token: m.livePhoto.token,
                            // 实况照片的视频部分优先使用从 XML 提取的 Key
                            key: videoKey || m.livePhoto.key || m.key,
                            encIdx: m.livePhoto.encIdx || m.livePhoto.enc_idx
                        }
                        : undefined
                }))

                return {
                    ...post,
                    avatarUrl: contact?.avatarUrl,
                    nickname: post.nickname || contact?.displayName || post.username,
                    media: fixedMedia
                }
            })
            return { ...result, timeline: enrichedTimeline }
        }

        return result
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

    async downloadImage(url: string, key?: string | number): Promise<{ success: boolean; data?: Buffer; contentType?: string; error?: string }> {
        return this.fetchAndDecryptImage(url, key)
    }

    private async fetchAndDecryptImage(url: string, key?: string | number): Promise<{ success: boolean; data?: Buffer; contentType?: string; cachePath?: string; error?: string }> {
        if (!url) return { success: false, error: 'url 不能为空' }

        const isVideo = isVideoUrl(url)
        const cachePath = this.getCacheFilePath(url)

        // 1. 尝试从磁盘缓存读取
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
                console.log(`[SnsService] 开始下载视频到临时文件: ${tmpPath}`)

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
                            console.log(`[SnsService] 视频下载完成，开始解密... Key: ${key}`)

                            try {
                                const encryptedBuffer = await readFile(tmpPath)
                                const raw = encryptedBuffer // 引用，方便后续操作


                                if (key && String(key).trim().length > 0) {
                                    try {
                                        console.log(`[SnsService] 使用 WASM Isaac64 解密视频... Key: ${key}`)
                                        const wasmService = WasmService.getInstance()
                                        // 只需要前 128KB (131072 bytes) 用于解密头部
                                        const keystream = await wasmService.getKeystream(String(key), 131072)

                                        const decryptLen = Math.min(keystream.length, raw.length)

                                        // XOR 解密
                                        for (let i = 0; i < decryptLen; i++) {
                                            raw[i] ^= keystream[i]
                                        }

                                        // 验证 MP4 签名 ('ftyp' at offset 4)
                                        const ftyp = raw.subarray(4, 8).toString('ascii')
                                        if (ftyp === 'ftyp') {
                                            console.log(`[SnsService] 视频解密成功: ${url}`)
                                        } else {
                                            console.warn(`[SnsService] 视频解密可能失败: ${url}, 未找到 ftyp 签名: ${ftyp}`)
                                            // 打印前 32 字节用于调试
                                            console.warn(`[SnsService] Decrypted Header (first 32 bytes): ${raw.subarray(0, 32).toString('hex')}`)
                                        }
                                    } catch (err) {
                                        console.error(`[SnsService] 视频解密出错: ${err}`)
                                    }
                                } else {
                                    console.warn(`[SnsService] 未提供 Key，跳过解密，直接保存`)
                                }

                                // 写入最终缓存 (覆盖)
                                await writeFile(cachePath, raw)
                                console.log(`[SnsService] 视频已保存到缓存: ${cachePath}`)

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
                            const decrypted = await wcdbService.decryptSnsImage(raw, String(key))
                            decoded = Buffer.from(decrypted)
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
                req.end()
            } catch (e: any) {
                resolve({ success: false, error: e.message })
            }
        })
    }
}

export const snsService = new SnsService()
