import { join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { ConfigService } from './config'
import Database from 'better-sqlite3'
import { wcdbService } from './wcdbService'

export interface VideoInfo {
    videoUrl?: string       // 视频文件路径（用于 readFile）
    coverUrl?: string       // 封面 data URL
    thumbUrl?: string       // 缩略图 data URL
    exists: boolean
}

class VideoService {
    private configService: ConfigService

    constructor() {
        this.configService = new ConfigService()
    }

    /**
     * 获取数据库根目录
     */
    private getDbPath(): string {
        return this.configService.get('dbPath') || ''
    }

    /**
     * 获取当前用户的wxid
     */
    private getMyWxid(): string {
        return this.configService.get('myWxid') || ''
    }

    /**
     * 获取缓存目录（解密后的数据库存放位置）
     */
    private getCachePath(): string {
        return this.configService.getCacheBasePath()
    }

    /**
     * 清理 wxid 目录名（去掉后缀）
     */
    private cleanWxid(wxid: string): string {
        const trimmed = wxid.trim()
        if (!trimmed) return trimmed

        if (trimmed.toLowerCase().startsWith('wxid_')) {
            const match = trimmed.match(/^(wxid_[^_]+)/i)
            if (match) return match[1]
            return trimmed
        }

        const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
        if (suffixMatch) return suffixMatch[1]

        return trimmed
    }

    /**
     * 从 video_hardlink_info_v4 表查询视频文件名
     * 优先使用 cachePath 中解密后的 hardlink.db（使用 better-sqlite3）
     * 如果失败，则尝试使用 wcdbService.execQuery 查询加密的 hardlink.db
     */
    private async queryVideoFileName(md5: string): Promise<string | undefined> {
        const cachePath = this.getCachePath()
        const dbPath = this.getDbPath()
        const wxid = this.getMyWxid()
        const cleanedWxid = this.cleanWxid(wxid)

        if (!wxid) return undefined

        // 方法1：优先在 cachePath 下查找解密后的 hardlink.db
        if (cachePath) {
            const cacheDbPaths = [
                join(cachePath, cleanedWxid, 'hardlink.db'),
                join(cachePath, wxid, 'hardlink.db'),
                join(cachePath, 'hardlink.db'),
                join(cachePath, 'databases', cleanedWxid, 'hardlink.db'),
                join(cachePath, 'databases', wxid, 'hardlink.db')
            ]

            for (const p of cacheDbPaths) {
                if (existsSync(p)) {
                    try {
                        const db = new Database(p, { readonly: true })
                        const row = db.prepare(`
                            SELECT file_name, md5 FROM video_hardlink_info_v4 
                            WHERE md5 = ? 
                            LIMIT 1
                        `).get(md5) as { file_name: string; md5: string } | undefined
                        db.close()

                        if (row?.file_name) {
                            const realMd5 = row.file_name.replace(/\.[^.]+$/, '')
                            return realMd5
                        }
                    } catch (e) {
                        // 忽略错误
                    }
                }
            }
        }

        // 方法2：使用 wcdbService.execQuery 查询加密的 hardlink.db
        if (dbPath) {
            // 检查 dbPath 是否已经包含 wxid
            const dbPathLower = dbPath.toLowerCase()
            const wxidLower = wxid.toLowerCase()
            const cleanedWxidLower = cleanedWxid.toLowerCase()
            const dbPathContainsWxid = dbPathLower.includes(wxidLower) || dbPathLower.includes(cleanedWxidLower)

            const encryptedDbPaths: string[] = []
            if (dbPathContainsWxid) {
                // dbPath 已包含 wxid，不需要再拼接
                encryptedDbPaths.push(join(dbPath, 'db_storage', 'hardlink', 'hardlink.db'))
            } else {
                // dbPath 不包含 wxid，需要拼接
                encryptedDbPaths.push(join(dbPath, wxid, 'db_storage', 'hardlink', 'hardlink.db'))
                encryptedDbPaths.push(join(dbPath, cleanedWxid, 'db_storage', 'hardlink', 'hardlink.db'))
            }

            for (const p of encryptedDbPaths) {
                if (existsSync(p)) {
                    try {
                        const escapedMd5 = md5.replace(/'/g, "''")

                        // 用 md5 字段查询，获取 file_name
                        const sql = `SELECT file_name FROM video_hardlink_info_v4 WHERE md5 = '${escapedMd5}' LIMIT 1`

                        const result = await wcdbService.execQuery('media', p, sql)

                        if (result.success && result.rows && result.rows.length > 0) {
                            const row = result.rows[0]
                            if (row?.file_name) {
                                // 提取不带扩展名的文件名作为实际视频 MD5
                                const realMd5 = String(row.file_name).replace(/\.[^.]+$/, '')
                                return realMd5
                            }
                        }
                    } catch (e) {
                        // 忽略错误
                    }
                }
            }
        }
        return undefined
    }

    /**
     * 将文件转换为 data URL
     */
    private fileToDataUrl(filePath: string, mimeType: string): string | undefined {
        try {
            if (!existsSync(filePath)) return undefined
            const buffer = readFileSync(filePath)
            return `data:${mimeType};base64,${buffer.toString('base64')}`
        } catch {
            return undefined
        }
    }

    /**
     * 根据视频MD5获取视频文件信息
     * 视频存放在: {数据库根目录}/{用户wxid}/msg/video/{年月}/
     * 文件命名: {md5}.mp4, {md5}.jpg, {md5}_thumb.jpg
     */
    async getVideoInfo(videoMd5: string): Promise<VideoInfo> {
        const dbPath = this.getDbPath()
        const wxid = this.getMyWxid()

        if (!dbPath || !wxid || !videoMd5) {
            return { exists: false }
        }

        // 先尝试从数据库查询真正的视频文件名
        const realVideoMd5 = await this.queryVideoFileName(videoMd5) || videoMd5

        // 检查 dbPath 是否已经包含 wxid，避免重复拼接
        const dbPathLower = dbPath.toLowerCase()
        const wxidLower = wxid.toLowerCase()
        const cleanedWxid = this.cleanWxid(wxid)

        let videoBaseDir: string
        if (dbPathLower.includes(wxidLower) || dbPathLower.includes(cleanedWxid.toLowerCase())) {
            // dbPath 已经包含 wxid，直接使用
            videoBaseDir = join(dbPath, 'msg', 'video')
        } else {
            // dbPath 不包含 wxid，需要拼接
            videoBaseDir = join(dbPath, wxid, 'msg', 'video')
        }

        if (!existsSync(videoBaseDir)) {
            return { exists: false }
        }

        // 遍历年月目录查找视频文件
        try {
            const allDirs = readdirSync(videoBaseDir)

            // 支持多种目录格式: YYYY-MM, YYYYMM, 或其他
            const yearMonthDirs = allDirs
                .filter(dir => {
                    const dirPath = join(videoBaseDir, dir)
                    return statSync(dirPath).isDirectory()
                })
                .sort((a, b) => b.localeCompare(a)) // 从最新的目录开始查找

            for (const yearMonth of yearMonthDirs) {
                const dirPath = join(videoBaseDir, yearMonth)

                const videoPath = join(dirPath, `${realVideoMd5}.mp4`)
                const coverPath = join(dirPath, `${realVideoMd5}.jpg`)
                const thumbPath = join(dirPath, `${realVideoMd5}_thumb.jpg`)

                // 检查视频文件是否存在
                if (existsSync(videoPath)) {
                    return {
                        videoUrl: videoPath,  // 返回文件路径，前端通过 readFile 读取
                        coverUrl: this.fileToDataUrl(coverPath, 'image/jpeg'),
                        thumbUrl: this.fileToDataUrl(thumbPath, 'image/jpeg'),
                        exists: true
                    }
                }
            }
        } catch (e) {
            // 忽略错误
        }

        return { exists: false }
    }

    /**
     * 根据消息内容解析视频MD5
     */
    parseVideoMd5(content: string): string | undefined {

        // 打印前500字符看看 XML 结构

        if (!content) return undefined

        try {
            // 提取所有可能的 md5 值进行日志
            const allMd5s: string[] = []
            const md5Regex = /(?:md5|rawmd5|newmd5|originsourcemd5)\s*=\s*['"]([a-fA-F0-9]+)['"]/gi
            let match
            while ((match = md5Regex.exec(content)) !== null) {
                allMd5s.push(`${match[0]}`)
            }

            // 提取 md5（用于查询 hardlink.db）
            // 注意：不是 rawmd5，rawmd5 是另一个值
            // 格式: md5="xxx" 或 <md5>xxx</md5>

            const attrPatterns = [
                /<videomsg[^>]*\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
                /\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
                /\srawmd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
                /\snewmd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
                /\soriginsourcemd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i
            ]
            for (const pattern of attrPatterns) {
                const match = pattern.exec(content)
                if (match?.[1]) return match[1].toLowerCase()
            }

            const tagPatterns = ['md5', 'rawmd5', 'newmd5', 'originsourcemd5']
            for (const tag of tagPatterns) {
                const match = new RegExp(`<${tag}>([a-fA-F0-9]+)<\\/${tag}>`, 'i').exec(content)
                if (match?.[1]) return match[1].toLowerCase()
            }
        } catch (e) {
            console.error('[VideoService] 解析视频MD5失败:', e)
        }

        return undefined
    }
}

export const videoService = new VideoService()
