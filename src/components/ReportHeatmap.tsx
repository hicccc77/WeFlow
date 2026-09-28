import React from 'react'
import './ReportComponents.scss'

interface ReportHeatmapProps {
    data: number[][]
}

const ReportHeatmap: React.FC<ReportHeatmapProps> = ({ data }) => {
    if (!data || data.length === 0) return null

    const maxHeat = Math.max(...data.flat())
    const weekLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

    return (
        <div className="heatmap-wrapper">
            <div className="heatmap-header">
                <div></div>
                <div className="time-labels">
                    {[0, 6, 12, 18].map(h => (
                        <span key={h} style={{ gridColumn: h + 1 }}>{h}</span>
                    ))}
                </div>
            </div>
            <div className="heatmap">
                <div className="heatmap-week-col">
                    {weekLabels.map(w => <div key={w} className="week-label">{w}</div>)}
                </div>
                <div className="heatmap-grid">
                    {data.map((row, wi) =>
                        row.map((val, hi) => {
                            const alpha = maxHeat > 0 ? (val / maxHeat * 0.85 + 0.1).toFixed(2) : '0.1'
                            return (
                                <div
                                    key={`${wi}-${hi}`}
                                    className="h-cell"
                                    style={{
                                        backgroundColor: 'var(--primary)',
                                        opacity: alpha
                                    }}
                                    title={`${weekLabels[wi]} ${hi}:00 - ${val}条`}
                                />
                            )
                        })
                    )}
                </div>
            </div>
        </div>
    )
}

export default ReportHeatmap
