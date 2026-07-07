import React, { memo, useRef, useCallback, useEffect, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Search, X, CheckSquare, Square, RefreshCw } from 'lucide-react'
import type { SessionRow, ConversationTab, ContactsSortConfig } from '../../types'
import type { SessionContentMetric } from '../../hooks/useSessionMetrics'
import { conversationTabLabels, exportKindPriority } from '../../constants'
import { getAvatarLetter } from '../../utils/format'
import { formatLatestMessageTimeFromSeconds } from '../../utils/format'
import { displayNameOrFallback } from '../../../../utils/displayName'
import './SessionTable.scss'

interface SessionTableProps {
  sessions: SessionRow[]
  activeTab: ConversationTab
  searchQuery: string
  sortConfig: ContactsSortConfig
  selectedSessionIds: Set<string>
  onTabChange: (tab: ConversationTab) => void
  onSearchChange: (query: string) => void
  onSortChange: (config: ContactsSortConfig) => void
  onSelectionChange: (selectedIds: Set<string>) => void
  onSingleExport?: (sessionId: string) => void
  onBatchExport?: () => void
  onAutomationExport?: () => void
  isLoading?: boolean
  error?: string | null
  metricsMap?: Record<string, SessionContentMetric>
  loadingRefs?: Set<string>
  metricsLoadingCount?: number
  onRefreshStats?: () => void
  isRefreshingStats?: boolean
}

const SessionTable: React.FC<SessionTableProps> = ({
  sessions,
  activeTab,
  searchQuery,
  sortConfig,
  selectedSessionIds,
  onTabChange,
  onSearchChange,
  onSortChange,
  onSelectionChange,
  onSingleExport,
  onBatchExport,
  onAutomationExport,
  isLoading,
  error,
  metricsMap,
  loadingRefs,
  metricsLoadingCount = 0,
  onRefreshStats,
  isRefreshingStats = false
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [isStatsNoticeMounted, setIsStatsNoticeMounted] = useState(false)
  const [isStatsNoticeLeaving, setIsStatsNoticeLeaving] = useState(false)
  const isMetricsScanning = metricsLoadingCount > 0

  useEffect(() => {
    if (isMetricsScanning) {
      setIsStatsNoticeMounted(true)
      setIsStatsNoticeLeaving(false)
      return
    }

    if (!isStatsNoticeMounted) return
    setIsStatsNoticeLeaving(true)
    const timer = window.setTimeout(() => {
      setIsStatsNoticeMounted(false)
      setIsStatsNoticeLeaving(false)
    }, 260)

    return () => window.clearTimeout(timer)
  }, [isMetricsScanning, isStatsNoticeMounted])

  const handleSearchClear = () => onSearchChange('')

  const handleSortClick = (key: ContactsSortConfig['key']) => {
    if (sortConfig.key === key) {
      if (sortConfig.order === 'desc') {
        onSortChange({ key, order: 'asc' })
      } else {
        onSortChange({ key, order: 'desc' })
      }
    } else {
      onSortChange({ key, order: 'desc' })
    }
  }

  const handleSelectAll = () => {
    if (selectedSessionIds.size === sessions.length && sessions.length > 0) {
      onSelectionChange(new Set())
    } else {
      onSelectionChange(new Set(sessions.map(s => s.username)))
    }
  }

  const toggleSelection = useCallback((username: string) => {
    const next = new Set(selectedSessionIds)
    if (next.has(username)) {
      next.delete(username)
    } else {
      next.add(username)
    }
    onSelectionChange(next)
  }, [selectedSessionIds, onSelectionChange])

  // Tabs layout
  const tabs: ConversationTab[] = ['private', 'group', 'official', 'former_friend']

  return (
    <div className="session-table-container">
      {/* ─── Search & Tabs (Top Filter) ─────────────────────────────────────────── */}
      <div className="st-top-filter">
        <div className="st-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => onTabChange(tab)}
            >
              {conversationTabLabels[tab]}
            </button>
          ))}
        </div>

        {selectedSessionIds.size > 0 && (
          <div className="st-selection-actions">
            <span className="st-selection-count">已选 {selectedSessionIds.size} 项</span>
            {onBatchExport && (
              <button className="st-selection-btn primary" onClick={onBatchExport}>
                批量导出
              </button>
            )}
            {onAutomationExport && (
              <button className="st-selection-btn secondary" onClick={onAutomationExport}>
                创建自动化
              </button>
            )}
          </div>
        )}
        
        <div className="st-search" style={{ marginLeft: selectedSessionIds.size > 0 ? '0' : 'auto' }}>
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder="搜索联系人、群组、微信号或备注..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {searchQuery && (
            <button className="clear-search-btn" onClick={handleSearchClear}>
              <X size={16} />
            </button>
          )}
        </div>

        {onRefreshStats && (
          <button
            type="button"
            className={`st-refresh-stats-btn ${isRefreshingStats ? 'refreshing' : ''}`}
            onClick={onRefreshStats}
            disabled={isRefreshingStats || isLoading || sessions.length === 0}
            title="重新统计当前列表"
            aria-label="重新统计当前列表"
          >
            <RefreshCw size={16} />
          </button>
        )}
      </div>

      {/* ─── Table Columns Header ─────────────────────────────────────── */}
      <div className="st-header-row">
        <div className="col-checkbox">
          <button className="checkbox-btn" onClick={handleSelectAll}>
            {selectedSessionIds.size === sessions.length && sessions.length > 0 ? (
              <CheckSquare size={18} className="checked" />
            ) : (
              <Square size={18} />
            )}
          </button>
        </div>
        <div className="col-info">会话 / 联系人</div>
        <div className="col-count sortable" onClick={() => handleSortClick('messageCount')} style={{ cursor: 'pointer', display: 'flex', gap: '4px', userSelect: 'none' }}>
          总消息数
          {sortConfig.key === 'messageCount' && (
            <span className="sort-icon">{sortConfig.order === 'desc' ? '↓' : '↑'}</span>
          )}
        </div>
        <div className="col-time sortable" onClick={() => handleSortClick('latestMessageTime')} style={{ cursor: 'pointer', display: 'flex', gap: '4px', userSelect: 'none' }}>
          最新消息时间
          {sortConfig.key === 'latestMessageTime' && (
            <span className="sort-icon">{sortConfig.order === 'desc' ? '↓' : '↑'}</span>
          )}
        </div>
        <div className="col-stat">表情包</div>
        <div className="col-stat">语音</div>
        <div className="col-stat">图片</div>
        <div className="col-stat">视频</div>
        <div className="col-stat">文件</div>
        <div className="col-action">操作</div>
      </div>

      {/* ─── Virtualized List ─────────────────────────────────────────── */}
      <div className="table-body">
        {error ? (
          <div className="error-state" role="alert">
            <div className="error-title">会话加载失败</div>
            <div className="error-message">{error}</div>
          </div>
        ) : isLoading && sessions.length === 0 ? (
          // 初始加载骨架屏，风格与「我的足迹」保持一致
          <div className="st-skeleton-body" aria-busy="true" aria-live="polite">
            <div className="st-skeleton-header">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="st-skeleton-cell st-skeleton-shimmer" />
              ))}
            </div>
            <div className="st-skeleton-rows">
              {Array.from({ length: 10 }).map((_, rowIndex) => (
                <div key={rowIndex} className="st-skeleton-row">
                  <div className="st-skeleton-checkbox st-skeleton-shimmer" />
                  <div className="st-skeleton-info">
                    <div className="st-skeleton-avatar st-skeleton-shimmer" />
                    <div className="st-skeleton-text">
                      <div className="st-skeleton-line st-skeleton-shimmer" />
                      <div className="st-skeleton-line short st-skeleton-shimmer" />
                    </div>
                  </div>
                  {Array.from({ length: 7 }).map((_, i) => (
                    <div key={i} className="st-skeleton-stat st-skeleton-shimmer" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <div className="empty-state">
            {searchQuery ? '没有匹配的会话' : '此分类下没有会话'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={sessions}
            itemContent={(index, session) => {
              if (!session) return null

              const metrics = metricsMap?.[session.username]
              const isMetricsLoading = !metrics && loadingRefs?.has(session.username)
              const totalCount = metrics?.totalMessages ?? session.messageCountHint ?? 0
              const sessionDisplayName = displayNameOrFallback(session.username, session.displayName)

              return (
                <div className="st-row" key={session.username}>
                  <div className="col-checkbox">
                    <button className="checkbox-btn" onClick={() => toggleSelection(session.username)}>
                      {selectedSessionIds.has(session.username) ? (
                        <CheckSquare size={18} className="checked" />
                      ) : (
                        <Square size={18} />
                      )}
                    </button>
                  </div>
                  <div className="col-info">
                    <div className="st-avatar">
                      {session.avatarUrl ? (
                        <img src={session.avatarUrl} alt="avatar" />
                      ) : (
                        <span className="avatar-letter">{getAvatarLetter(sessionDisplayName)}</span>
                      )}
                    </div>
                    <div className="st-text">
                      <span className="st-name" title={sessionDisplayName}>{sessionDisplayName}</span>
                      <span className="st-id" title={session.username}>{session.username}</span>
                    </div>
                  </div>
                  <div className="col-count">
                    {isMetricsLoading ? (
                      <span className="st-stat-shimmer" />
                    ) : (
                      <span className="st-stat-fade-in">{totalCount.toLocaleString()}</span>
                    )}
                  </div>
                  <div className="col-time">
                    {session.lastTimestamp ? formatLatestMessageTimeFromSeconds(session.lastTimestamp).text : '-'}
                  </div>
                  <div className="col-stat">
                    {isMetricsLoading ? (
                      <span className="st-stat-shimmer" />
                    ) : (
                      <span className="st-stat-fade-in">{metrics?.emojiMessages ?? '-'}</span>
                    )}
                  </div>
                  <div className="col-stat">
                    {isMetricsLoading ? (
                      <span className="st-stat-shimmer" />
                    ) : (
                      <span className="st-stat-fade-in">{metrics?.voiceMessages ?? '-'}</span>
                    )}
                  </div>
                  <div className="col-stat">
                    {isMetricsLoading ? (
                      <span className="st-stat-shimmer" />
                    ) : (
                      <span className="st-stat-fade-in">{metrics?.imageMessages ?? '-'}</span>
                    )}
                  </div>
                  <div className="col-stat">
                    {isMetricsLoading ? (
                      <span className="st-stat-shimmer" />
                    ) : (
                      <span className="st-stat-fade-in">{metrics?.videoMessages ?? '-'}</span>
                    )}
                  </div>
                  <div className="col-stat">
                    {isMetricsLoading ? (
                      <span className="st-stat-shimmer" />
                    ) : (
                      <span className="st-stat-fade-in">{metrics?.fileMessages ?? '-'}</span>
                    )}
                  </div>
                  <div className="col-action">
                    <button
                      className="st-action-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSingleExport?.(session.username)
                      }}
                    >
                      导出
                    </button>
                  </div>
                </div>
              )
            }}
          />
        )}

        {isStatsNoticeMounted && (
          <div
            className={`st-metrics-status ${isStatsNoticeLeaving ? 'leaving' : ''}`}
            aria-live="polite"
          >
            <span className="st-metrics-status-dot" />
            <span>正在统计会话消息，已完成的结果会逐行更新</span>
            <span className="st-metrics-status-count">{metricsLoadingCount.toLocaleString()} 项</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(SessionTable)
