import React, { useEffect, useState } from 'react'
import { Quote, X } from 'lucide-react'
import './UpdateDialog.scss'

interface UpdateInfo {
    version?: string
    releaseNotes?: string
}

interface UpdateDialogProps {
    open: boolean
    updateInfo: UpdateInfo | null
    onClose: () => void
    onUpdate: () => void
    onIgnore?: () => void
    isDownloading: boolean
    isMandatory?: boolean
    progress: number | {
        percent: number
        bytesPerSecond?: number
        transferred?: number
        total?: number
        remaining?: number // seconds
    }
}

const UpdateDialog: React.FC<UpdateDialogProps> = ({
    open,
    updateInfo,
    onClose,
    onUpdate,
    onIgnore,
    isDownloading,
    isMandatory,
    progress
}) => {
    if (!open || !updateInfo) return null

    // Safe normalize progress
    const safeProgress = typeof progress === 'number' ? { percent: progress } : (progress || { percent: 0 })
    const percent = safeProgress.percent || 0
    const bytesPerSecond = safeProgress.bytesPerSecond
    const total = safeProgress.total
    const transferred = safeProgress.transferred
    const remaining = safeProgress.remaining

    // Format bytes
    const formatBytes = (bytes: number) => {
        if (!Number.isFinite(bytes) || bytes === 0) return '0 B'
        const k = 1024
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        const unitIndex = Math.max(0, Math.min(i, sizes.length - 1))
        return parseFloat((bytes / Math.pow(k, unitIndex)).toFixed(1)) + ' ' + sizes[unitIndex]
    }

    // Format speed
    const formatSpeed = (bytesPerSecond: number) => {
        return `${formatBytes(bytesPerSecond)}/s`
    }

    // Format time
    const formatTime = (seconds: number) => {
        if (!Number.isFinite(seconds)) return '计算中...'
        if (seconds < 60) return `${Math.ceil(seconds)} 秒`
        const minutes = Math.floor(seconds / 60)
        const remainingSeconds = Math.ceil(seconds % 60)
        return `${minutes} 分 ${remainingSeconds} 秒`
    }

    return (
        <div className="update-dialog-overlay">
            <div className="update-dialog">
                {!isDownloading && !isMandatory && (
                    <button className="close-btn" onClick={onClose}>
                        <X size={20} />
                    </button>
                )}

                <div className="dialog-header">
                    <div className="version-tag">
                        新版本 {updateInfo.version}
                    </div>
                    <h2>欢迎体验全新的 WeFlow</h2>
                    <div className="subtitle">我们带来了一些改进</div>
                </div>

                <div className="dialog-content">
                    <div className="update-notes-container">
                        <div className="icon-box">
                            <Quote size={20} />
                        </div>
                        <div className="text-box">
                            {updateInfo.releaseNotes ? (
                                <div dangerouslySetInnerHTML={{ __html: updateInfo.releaseNotes }} />
                            ) : (
                                <p>修复了一些已知问题，提升了稳定性。</p>
                            )}
                        </div>
                    </div>

                    {isDownloading ? (
                        <div className="progress-section">
                            <div className="progress-info-row">
                                <span>{bytesPerSecond ? formatSpeed(bytesPerSecond) : '下载中...'}</span>
                                <span>{total ? `${formatBytes(transferred || 0)} / ${formatBytes(total)}` : `${percent.toFixed(1)}%`}</span>
                                {remaining !== undefined && <span>剩余 {formatTime(remaining)}</span>}
                            </div>

                            <div className="progress-bar-bg">
                                <div
                                    className="progress-bar-fill"
                                    style={{ width: `${percent}%` }}
                                />
                            </div>

                            {/* Fallback status text if detailed info is missing */}
                            {(!bytesPerSecond && !total) && (
                                <div className="status-text">{percent.toFixed(0)}% 已下载</div>
                            )}
                        </div>
                    ) : (
                        <div className="actions">
                            {onIgnore && !isMandatory && (
                                <button className="btn-ignore" onClick={onIgnore}>
                                    忽略本次更新
                                </button>
                            )}
                            {isMandatory && (
                                <p className="mandatory-tip">此版本存在安全风险，必须更新后才能继续使用</p>
                            )}
                            <button className="btn-update" onClick={onUpdate}>
                                开启新旅程
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

export default UpdateDialog
