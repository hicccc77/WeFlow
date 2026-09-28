import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X, CheckCircle, XCircle, AlertCircle, Clock, Mic } from 'lucide-react'
import { useBatchTranscribeStore } from '../stores/batchTranscribeStore'
import '../styles/batchTranscribe.scss'

/**
 * 全局批量转写进度浮窗 + 结果弹窗
 * 挂载在 App 层，切换页面时不会消失
 */
export const BatchTranscribeGlobal: React.FC = () => {
  const {
    isBatchTranscribing,
    progress,
    showToast,
    showResult,
    result,
    sessionName,
    startTime,
    taskType,
    setShowToast,
    setShowResult
  } = useBatchTranscribeStore()

  const [eta, setEta] = useState<string>('')

  // 计算剩余时间
  useEffect(() => {
    if (!isBatchTranscribing || !startTime || progress.current === 0) {
      setEta('')
      return
    }

    const timer = setInterval(() => {
      const now = Date.now()
      const elapsed = now - startTime
      const rate = progress.current / elapsed // ms per item
      const remainingItems = progress.total - progress.current

      if (remainingItems <= 0) {
        setEta('')
        return
      }

      const remainingTimeMs = remainingItems / rate
      const remainingSeconds = Math.ceil(remainingTimeMs / 1000)

      if (remainingSeconds < 60) {
        setEta(`${remainingSeconds}秒`)
      } else {
        const minutes = Math.floor(remainingSeconds / 60)
        const seconds = remainingSeconds % 60
        setEta(`${minutes}分${seconds}秒`)
      }
    }, 1000)

    return () => clearInterval(timer)
  }, [isBatchTranscribing, startTime, progress.current, progress.total])

  return (
    <>
      {/* 批量转写进度浮窗（非阻塞） */}
      {showToast && isBatchTranscribing && createPortal(
        <div className="batch-progress-toast">
          <div className="batch-progress-toast-header">
            <div className="batch-progress-toast-title">
              <Loader2 size={14} className="spin" />
              <span>{taskType === 'decrypt' ? '批量解密语音中' : '批量转写中'}{sessionName ? `（${sessionName}）` : ''}</span>
            </div>
            <button className="batch-progress-toast-close" onClick={() => setShowToast(false)} title="最小化">
              <X size={14} />
            </button>
          </div>
          <div className="batch-progress-toast-body">
            <div className="progress-info-row">
              <div className="progress-text">
                <span>{progress.current} / {progress.total}</span>
                <span className="progress-percent">
                  {progress.total > 0
                    ? Math.round((progress.current / progress.total) * 100)
                    : 0}%
                </span>
              </div>
              {eta && (
                <div className="progress-eta">
                  <Clock size={12} />
                  <span>剩余 {eta}</span>
                </div>
              )}
            </div>

            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${progress.total > 0
                    ? (progress.current / progress.total) * 100
                    : 0}%`
                }}
              />
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 批量转写结果对话框 */}
      {showResult && createPortal(
        <div className="batch-modal-overlay" onClick={() => setShowResult(false)}>
          <div className="batch-modal-content batch-result-modal" onClick={(e) => e.stopPropagation()}>
            <div className="batch-modal-header">
              {taskType === 'decrypt' ? <Mic size={20} /> : <CheckCircle size={20} />}
              <h3>{taskType === 'decrypt' ? '语音解密完成' : '转写完成'}</h3>
            </div>
            <div className="batch-modal-body">
              <div className="result-summary">
                <div className="result-item success">
                  <CheckCircle size={18} />
                  <span className="label">成功:</span>
                  <span className="value">{result.success} 条</span>
                </div>
                {result.fail > 0 && (
                  <div className="result-item fail">
                    <XCircle size={18} />
                    <span className="label">失败:</span>
                    <span className="value">{result.fail} 条</span>
                  </div>
                )}
              </div>
              {result.fail > 0 && (
                <div className="result-tip">
                  <AlertCircle size={16} />
                  <span>{taskType === 'decrypt' ? '部分语音解密失败，可能是语音未缓存或文件损坏' : '部分语音转写失败，可能是语音文件损坏或网络问题'}</span>
                </div>
              )}
            </div>
            <div className="batch-modal-footer">
              <button className="btn-primary" onClick={() => setShowResult(false)}>
                确定
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
