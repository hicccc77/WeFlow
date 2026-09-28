import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X, Image as ImageIcon, Clock, CheckCircle, XCircle } from 'lucide-react'
import { useBatchImageDecryptStore } from '../stores/batchImageDecryptStore'
import { useBatchTranscribeStore } from '../stores/batchTranscribeStore'
import '../styles/batchTranscribe.scss'

export const BatchImageDecryptGlobal: React.FC = () => {
  const {
    isBatchDecrypting,
    progress,
    showToast,
    showResultToast,
    result,
    sessionName,
    startTime,
    setShowToast,
    setShowResultToast
  } = useBatchImageDecryptStore()

  const voiceToastOccupied = useBatchTranscribeStore(
    state => state.isBatchTranscribing && state.showToast
  )

  const [eta, setEta] = useState('')

  useEffect(() => {
    if (!isBatchDecrypting || !startTime || progress.current === 0) {
      setEta('')
      return
    }

    const timer = setInterval(() => {
      const elapsed = Date.now() - startTime
      if (elapsed <= 0) return
      const rate = progress.current / elapsed
      const remain = progress.total - progress.current
      if (remain <= 0 || rate <= 0) {
        setEta('')
        return
      }
      const seconds = Math.ceil((remain / rate) / 1000)
      if (seconds < 60) {
        setEta(`${seconds}秒`)
      } else {
        const m = Math.floor(seconds / 60)
        const s = seconds % 60
        setEta(`${m}分${s}秒`)
      }
    }, 1000)

    return () => clearInterval(timer)
  }, [isBatchDecrypting, progress.current, progress.total, startTime])

  useEffect(() => {
    if (!showResultToast) return
    const timer = window.setTimeout(() => setShowResultToast(false), 6000)
    return () => window.clearTimeout(timer)
  }, [showResultToast, setShowResultToast])

  const toastBottom = useMemo(() => (voiceToastOccupied ? 148 : 24), [voiceToastOccupied])

  return (
    <>
      {showToast && isBatchDecrypting && createPortal(
        <div className="batch-progress-toast" style={{ bottom: toastBottom }}>
          <div className="batch-progress-toast-header">
            <div className="batch-progress-toast-title">
              <Loader2 size={14} className="spin" />
              <span>批量解密图片{sessionName ? `（${sessionName}）` : ''}</span>
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
                  {progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%
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
                  width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`
                }}
              />
            </div>
          </div>
        </div>,
        document.body
      )}

      {showResultToast && createPortal(
        <div className="batch-progress-toast batch-inline-result-toast" style={{ bottom: toastBottom }}>
          <div className="batch-progress-toast-header">
            <div className="batch-progress-toast-title">
              <ImageIcon size={14} />
              <span>图片批量解密完成</span>
            </div>
            <button className="batch-progress-toast-close" onClick={() => setShowResultToast(false)} title="关闭">
              <X size={14} />
            </button>
          </div>
          <div className="batch-progress-toast-body">
            <div className="batch-inline-result-summary">
              <div className="batch-inline-result-item success">
                <CheckCircle size={14} />
                <span>成功 {result.success}</span>
              </div>
              <div className={`batch-inline-result-item ${result.fail > 0 ? 'fail' : 'muted'}`}>
                <XCircle size={14} />
                <span>失败 {result.fail}</span>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

