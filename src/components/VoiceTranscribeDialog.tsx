import React, { useState, useEffect } from 'react'
import { Download, X, CheckCircle, AlertCircle } from 'lucide-react'
import './VoiceTranscribeDialog.scss'

interface VoiceTranscribeDialogProps {
    onClose: () => void
    onDownloadComplete: () => void
}

export const VoiceTranscribeDialog: React.FC<VoiceTranscribeDialogProps> = ({
    onClose,
    onDownloadComplete
}) => {
    const [isDownloading, setIsDownloading] = useState(false)
    const [downloadProgress, setDownloadProgress] = useState(0)
    const [downloadError, setDownloadError] = useState<string | null>(null)
    const [isComplete, setIsComplete] = useState(false)

    useEffect(() => {
        // 监听下载进度
        if (!window.electronAPI?.whisper?.onDownloadProgress) {
            console.warn('[VoiceTranscribeDialog] whisper API 不可用')
            return
        }

        const removeListener = window.electronAPI.whisper.onDownloadProgress((payload: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number }) => {
            if (payload.percent !== undefined) {
                setDownloadProgress(payload.percent)
            }
        })

        return () => {
            removeListener?.()
        }
    }, [])

    const handleDownload = async () => {
        if (!window.electronAPI?.whisper?.downloadModel) {
            setDownloadError('语音转文字功能不可用')
            return
        }

        setIsDownloading(true)
        setDownloadError(null)
        setDownloadProgress(0)

        try {
            const result = await window.electronAPI.whisper.downloadModel()

            if (result?.success) {
                setIsComplete(true)
                setDownloadProgress(100)

                // 延迟关闭弹窗并触发转写
                setTimeout(() => {
                    onDownloadComplete()
                }, 1000)
            } else {
                setDownloadError(result?.error || '下载失败')
                setIsDownloading(false)
            }
        } catch (error) {
            setDownloadError(String(error))
            setIsDownloading(false)
        }
    }

    const handleCancel = () => {
        if (!isDownloading && !isComplete) {
            onClose()
        }
    }

    return (
        <div className="voice-transcribe-dialog-overlay" onClick={handleCancel}>
            <div className="voice-transcribe-dialog" onClick={(e) => e.stopPropagation()}>
                <div className="dialog-header">
                    <h3>语音转文字</h3>
                    {!isDownloading && !isComplete && (
                        <button className="close-button" onClick={onClose}>
                            <X size={20} />
                        </button>
                    )}
                </div>

                <div className="dialog-content">
                    {!isDownloading && !isComplete && (
                        <>
                            <div className="info-section">
                                <AlertCircle size={48} className="info-icon" />
                                <p className="info-text">
                                    首次使用语音转文字功能需要下载 AI 模型
                                </p>
                                <div className="model-info">
                                    <div className="model-item">
                                        <span className="label">模型名称：</span>
                                        <span className="value">SenseVoiceSmall</span>
                                    </div>
                                    <div className="model-item">
                                        <span className="label">文件大小：</span>
                                        <span className="value">约 240 MB</span>
                                    </div>
                                    <div className="model-item">
                                        <span className="label">支持语言：</span>
                                        <span className="value">中文、粤语、英文、日文、韩文</span>
                                    </div>
                                </div>
                            </div>

                            {downloadError && (
                                <div className="error-message">
                                    <AlertCircle size={16} />
                                    <span>{downloadError}</span>
                                </div>
                            )}

                            <div className="dialog-actions">
                                <button className="btn-secondary" onClick={onClose}>
                                    取消
                                </button>
                                <button className="btn-primary" onClick={handleDownload}>
                                    <Download size={16} />
                                    <span>立即下载</span>
                                </button>
                            </div>
                        </>
                    )}

                    {isDownloading && !isComplete && (
                        <div className="download-section">
                            <div className="download-icon">
                                <Download size={48} className="downloading-icon" />
                            </div>
                            <p className="download-text">
                                {downloadProgress < 1 ? '正在连接服务器...' : '正在下载模型...'}
                            </p>
                            <div className="progress-bar">
                                <div
                                    className="progress-fill"
                                    style={{ width: `${downloadProgress}%` }}
                                />
                            </div>
                            <p className="progress-text">{downloadProgress.toFixed(1)}%</p>
                            {downloadProgress < 1 && (
                                <p className="download-hint">首次连接可能需要较长时间，请耐心等待</p>
                            )}
                        </div>
                    )}

                    {isComplete && (
                        <div className="complete-section">
                            <CheckCircle size={48} className="complete-icon" />
                            <p className="complete-text">下载完成！正在转写语音...</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
