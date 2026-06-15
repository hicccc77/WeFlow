import React from 'react'
import { useAppStore } from '../stores/appStore'
import { Download, X, AlertCircle, Info } from 'lucide-react'
import './UpdateProgressCapsule.scss'

const UpdateProgressCapsule: React.FC = () => {
    const {
        isDownloading,
        downloadProgress,
        showUpdateDialog,
        setShowUpdateDialog,
        updateInfo,
        setUpdateInfo,
        updateError,
        setUpdateError
    } = useAppStore()

    // Control visibility
    // If dialog is open, we usually hide the capsule UNLESS we want it as a mini-indicator
    // For now, let's hide it if the dialog is open
    if (showUpdateDialog) return null

    // State mapping
    const hasError = !!updateError
    const hasUpdate = !!updateInfo && updateInfo.hasUpdate

    if (!hasError && !isDownloading && !hasUpdate) return null

    // Safe normalize progress
    const safeProgress = typeof downloadProgress === 'number' ? { percent: downloadProgress } : (downloadProgress || { percent: 0 })
    const percent = safeProgress.percent || 0
    const bytesPerSecond = safeProgress.bytesPerSecond

    const formatBytes = (bytes: number) => {
        if (!Number.isFinite(bytes) || bytes === 0) return '0 B'
        const k = 1024
        const sizes = ['B', 'KB', 'MB', 'GB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        const unitIndex = Math.max(0, Math.min(i, sizes.length - 1))
        return parseFloat((bytes / Math.pow(k, unitIndex)).toFixed(1)) + ' ' + sizes[unitIndex]
    }

    const formatSpeed = (bps: number) => {
        return `${formatBytes(bps)}/s`
    }

    const handleClose = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (hasError) {
            setUpdateError(null)
        } else if (hasUpdate && !isDownloading) {
            setUpdateInfo(null)
        }
    }

    // Determine appearance class and content
    let capsuleClass = 'update-progress-capsule'
    let content = null

    if (hasError) {
        capsuleClass += ' state-error'
        content = (
            <>
                <div className="icon-wrapper">
                    <AlertCircle size={14} />
                </div>
                <div className="info-wrapper">
                    <span className="error-text">更新失败: {updateError}</span>
                </div>
            </>
        )
    } else if (isDownloading) {
        capsuleClass += ' state-downloading'
        content = (
            <>
                <div className="icon-wrapper">
                    <Download size={14} className="download-icon" />
                </div>
                <div className="info-wrapper">
                    <span className="percent-text">{percent.toFixed(0)}%</span>
                    {bytesPerSecond > 0 && (
                        <span className="speed-text">{formatSpeed(bytesPerSecond)}</span>
                    )}
                </div>
                <div className="progress-bg">
                    <div className="progress-fill" style={{ width: `${percent}%` }} />
                </div>
            </>
        )
    } else if (hasUpdate) {
        capsuleClass += ' state-available'
        content = (
            <>
                <div className="icon-wrapper">
                    <Info size={14} />
                </div>
                <div className="info-wrapper">
                    <span className="available-text">发现新版本 v{updateInfo?.version}</span>
                </div>
            </>
        )
    }

    return (
        <div className={capsuleClass} onClick={() => setShowUpdateDialog(true)}>
            <div className="capsule-content">
                {content}
                {!isDownloading && (
                    <button className="capsule-close" onClick={handleClose}>
                        <X size={12} />
                    </button>
                )}
            </div>
        </div>
    )
}

export default UpdateProgressCapsule
