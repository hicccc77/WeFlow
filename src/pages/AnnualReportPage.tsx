import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Calendar, Loader2, Sparkles } from 'lucide-react'
import './AnnualReportPage.scss'

function AnnualReportPage() {
  const navigate = useNavigate()
  const [availableYears, setAvailableYears] = useState<number[]>([])
  const [selectedYear, setSelectedYear] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)

  useEffect(() => {
    loadAvailableYears()
  }, [])

  const loadAvailableYears = async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.annualReport.getAvailableYears()
      if (result.success && result.data && result.data.length > 0) {
        setAvailableYears(result.data)
        setSelectedYear(result.data[0])
      }
    } catch (e) {
      console.error(e)
    } finally {
      setIsLoading(false)
    }
  }

  const handleGenerateReport = async () => {
    if (!selectedYear) return
    setIsGenerating(true)
    try {
      navigate(`/annual-report/view?year=${selectedYear}`)
    } catch (e) {
      console.error('生成报告失败:', e)
    } finally {
      setIsGenerating(false)
    }
  }

  if (isLoading) {
    return (
      <div className="annual-report-page">
        <Loader2 size={32} className="spin" style={{ color: 'var(--text-tertiary)' }} />
        <p style={{ color: 'var(--text-tertiary)', marginTop: 16 }}>正在加载年份数据...</p>
      </div>
    )
  }

  if (availableYears.length === 0) {
    return (
      <div className="annual-report-page">
        <Calendar size={64} style={{ color: 'var(--text-tertiary)', opacity: 0.5 }} />
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', margin: '16px 0 8px' }}>暂无聊天记录</h2>
        <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>请先解密数据库后再生成年度报告</p>
      </div>
    )
  }

  return (
    <div className="annual-report-page">
      <Sparkles size={32} className="header-icon" />
      <h1 className="page-title">年度报告</h1>
      <p className="page-desc">选择年份，生成你的微信聊天年度回顾</p>

      <div className="year-grid">
        {availableYears.map(year => (
          <div
            key={year}
            className={`year-card ${selectedYear === year ? 'selected' : ''}`}
            onClick={() => setSelectedYear(year)}
          >
            <span className="year-number">{year}</span>
            <span className="year-label">年</span>
          </div>
        ))}
      </div>

      <button
        className="generate-btn"
        onClick={handleGenerateReport}
        disabled={!selectedYear || isGenerating}
      >
        {isGenerating ? (
          <>
            <Loader2 size={20} className="spin" />
            <span>正在生成...</span>
          </>
        ) : (
          <>
            <Sparkles size={20} />
            <span>生成 {selectedYear} 年度报告</span>
          </>
        )}
      </button>
    </div>
  )
}

export default AnnualReportPage
