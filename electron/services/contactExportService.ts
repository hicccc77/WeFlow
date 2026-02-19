import * as fs from 'fs'
import * as path from 'path'
import { chatService } from './chatService'

interface ContactExportOptions {
    format: 'json' | 'csv' | 'vcf'
    exportAvatars: boolean
    contactTypes: {
        friends: boolean
        groups: boolean
        officials: boolean
    }
    selectedUsernames?: string[]
}

/**
 * 联系人导出服务
 */
class ContactExportService {
    /**
     * 导出联系人
     */
    async exportContacts(
        outputDir: string,
        options: ContactExportOptions
    ): Promise<{ success: boolean; successCount?: number; error?: string }> {
        try {
            // 获取所有联系人
            const contactsResult = await chatService.getContacts()
            if (!contactsResult.success || !contactsResult.contacts) {
                return { success: false, error: contactsResult.error || '获取联系人失败' }
            }

            let contacts = contactsResult.contacts

            // 根据类型过滤
            contacts = contacts.filter(c => {
                if (c.type === 'friend' && !options.contactTypes.friends) return false
                if (c.type === 'group' && !options.contactTypes.groups) return false
                if (c.type === 'official' && !options.contactTypes.officials) return false
                return true
            })

            if (Array.isArray(options.selectedUsernames) && options.selectedUsernames.length > 0) {
                const selectedSet = new Set(options.selectedUsernames)
                contacts = contacts.filter(c => selectedSet.has(c.username))
            }

            if (contacts.length === 0) {
                return { success: false, error: '没有符合条件的联系人' }
            }

            // 确保输出目录存在
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true })
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
            let outputPath: string

            switch (options.format) {
                case 'json':
                    outputPath = path.join(outputDir, `contacts_${timestamp}.json`)
                    await this.exportToJSON(contacts, outputPath)
                    break
                case 'csv':
                    outputPath = path.join(outputDir, `contacts_${timestamp}.csv`)
                    await this.exportToCSV(contacts, outputPath)
                    break
                case 'vcf':
                    outputPath = path.join(outputDir, `contacts_${timestamp}.vcf`)
                    await this.exportToVCF(contacts, outputPath)
                    break
                default:
                    return { success: false, error: '不支持的导出格式' }
            }

            return { success: true, successCount: contacts.length }
        } catch (e) {
            return { success: false, error: String(e) }
        }
    }

    /**
     * 导出为JSON格式
     */
    private async exportToJSON(contacts: any[], outputPath: string): Promise<void> {
        const data = {
            exportedAt: new Date().toISOString(),
            count: contacts.length,
            contacts: contacts.map(c => ({
                username: c.username,
                displayName: c.displayName,
                remark: c.remark,
                nickname: c.nickname,
                type: c.type
            }))
        }
        fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8')
    }

    /**
     * 导出为CSV格式
     */
    private async exportToCSV(contacts: any[], outputPath: string): Promise<void> {
        const headers = ['用户名', '显示名称', '备注', '昵称', '类型']
        const rows = contacts.map(c => [
            c.username || '',
            c.displayName || '',
            c.remark || '',
            c.nickname || '',
            this.getTypeLabel(c.type)
        ])

        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n')

        fs.writeFileSync(outputPath, '\uFEFF' + csvContent, 'utf-8') // 添加BOM以支持Excel
    }

    /**
     * 导出为VCF格式（vCard）
     */
    private async exportToVCF(contacts: any[], outputPath: string): Promise<void> {
        const vcards = contacts
            .filter(c => c.type === 'friend') // VCF通常只用于个人联系人
            .map(c => {
                const lines = ['BEGIN:VCARD', 'VERSION:3.0']

                // 全名
                lines.push(`FN:${c.displayName || c.username}`)

                // 昵称
                if (c.nickname) {
                    lines.push(`NICKNAME:${c.nickname}`)
                }

                // 备注
                if (c.remark) {
                    lines.push(`NOTE:${c.remark}`)
                }

                // 微信ID
                lines.push(`X-WECHAT-ID:${c.username}`)

                lines.push('END:VCARD')
                return lines.join('\r\n')
            })

        fs.writeFileSync(outputPath, vcards.join('\r\n\r\n'), 'utf-8')
    }

    private getTypeLabel(type: string): string {
        switch (type) {
            case 'friend': return '好友'
            case 'group': return '群聊'
            case 'official': return '公众号'
            default: return '其他'
        }
    }
}

export const contactExportService = new ContactExportService()
