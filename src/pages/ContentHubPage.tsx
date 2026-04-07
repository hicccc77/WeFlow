import { useEffect, useState } from 'react'
import { Search, Star, EyeOff, ExternalLink, Sparkles, Loader2, ChevronDown, X, FileText, Link, Image, Film, Newspaper, BookmarkPlus } from 'lucide-react'
import { useContentHubStore, type ContentItem } from '../stores/contentHubStore'
import './ContentHubPage.scss'

const CONTENT_TYPES = ['公众号', '链接', '文件', '图片', '视频'] as const
const TIME_OPTIONS = [
  { label: '最近7天', value: 7 },
  { label: '最近30天', value: 30 },
  { label: '最近90天', value: 90 },
  { label: '全部', value: 365 },
]

function getTypeIcon(type: string) {
  switch (type) {
    case '公众号': return <Newspaper size={14} />
    case '链接': return <Link size={14} />
    case '文件': return <FileText size={14} />
    case '图片': return <Image size={14} />
    case '视频': return <Film size={14} />
    default: return <FileText size={14} />
  }
}

function getRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const days = Math.floor(diff / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  return `${days}天前`
}

function ContentHubPage() {
  const {
    items,
    filters,
    selectedItem,
    analysisResult,
    isLoading,
    isAnalyzing,
    setFilter,
    loadContent,
    analyzeContent,
    selectItem,
    toggleStarred,
    toggleIgnored,
  } = useContentHubStore()

  const [contactSearch, setContactSearch] = useState('')
  const [showFilters, setShowFilters] = useState(true)

  useEffect(() => {
    loadContent()
  }, [loadContent])

  // Apply filters
  const filteredItems = items.filter(item => {
    if (item.ignored) return false
    if (filters.types.length > 0 && !filters.types.includes(item.type)) return false
    if (filters.sources.length > 0 && !filters.sources.includes(item.source)) return false
    if (filters.contact && !item.source.includes(filters.contact)) return false
    const daysAgo = (Date.now() - item.timestamp) / 86400000
    if (daysAgo > filters.days) return false
    return true
  })

  const uniqueSources = [...new Set(items.map(i => i.source))]

  const handleTypeToggle = (type: string) => {
    const current = filters.types
    const updated = current.includes(type)
      ? current.filter(t => t !== type)
      : [...current, type]
    setFilter('types', updated)
  }

  const handleSourceToggle = (source: string) => {
    const current = filters.sources
    const updated = current.includes(source)
      ? current.filter(s => s !== source)
      : [...current, source]
    setFilter('sources', updated)
  }

  return (
    <div className="content-hub-page">
      {/* Filter Panel */}
      <div className={`content-filter-panel ${showFilters ? '' : 'collapsed'}`}>
        <div className="filter-header">
          <h3>筛选</h3>
          <button className="filter-collapse-btn" onClick={() => setShowFilters(!showFilters)}>
            {showFilters ? <X size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {showFilters && (
          <>
            <div className="filter-section">
              <h4>内容类型</h4>
              {CONTENT_TYPES.map(type => (
                <label key={type} className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={filters.types.includes(type)}
                    onChange={() => handleTypeToggle(type)}
                  />
                  <span className="checkbox-icon">{getTypeIcon(type)}</span>
                  <span>{type}</span>
                </label>
              ))}
            </div>

            <div className="filter-section">
              <h4>来源</h4>
              {uniqueSources.map(source => (
                <label key={source} className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={filters.sources.includes(source)}
                    onChange={() => handleSourceToggle(source)}
                  />
                  <span>{source}</span>
                </label>
              ))}
            </div>

            <div className="filter-section">
              <h4>联系人</h4>
              <div className="filter-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="搜索联系人..."
                  value={contactSearch}
                  onChange={e => {
                    setContactSearch(e.target.value)
                    setFilter('contact', e.target.value)
                  }}
                />
              </div>
            </div>

            <div className="filter-section">
              <h4>时间范围</h4>
              <select
                className="filter-select"
                value={filters.days}
                onChange={e => setFilter('days', Number(e.target.value))}
              >
                {TIME_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      {/* Content Cards */}
      <div className="content-cards-area">
        {isLoading ? (
          <div className="content-loading">
            <Loader2 size={24} className="spinning" />
            <p>加载内容中...</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="content-empty">
            <BookmarkPlus size={32} />
            <p>暂无匹配的内容</p>
          </div>
        ) : (
          <div className="content-card-list">
            {filteredItems.map((item, index) => (
              <ContentCard
                key={item.id}
                item={item}
                isSelected={selectedItem?.id === item.id}
                index={index}
                onSelect={() => selectItem(item)}
                onAnalyze={() => analyzeContent(item.id)}
                onToggleStar={() => toggleStarred(item.id)}
                onToggleIgnore={() => toggleIgnored(item.id)}
                isAnalyzing={isAnalyzing && selectedItem?.id === item.id}
              />
            ))}
          </div>
        )}

        {/* Analysis Result */}
        {analysisResult && selectedItem && (
          <div className="content-analysis-panel">
            <div className="analysis-panel-header">
              <Sparkles size={16} />
              <h3>AI 分析: {selectedItem.title}</h3>
              <button onClick={() => selectItem(null)}><X size={16} /></button>
            </div>
            <div className="analysis-panel-body">
              {analysisResult.split('\n').map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface ContentCardProps {
  item: ContentItem
  isSelected: boolean
  index: number
  onSelect: () => void
  onAnalyze: () => void
  onToggleStar: () => void
  onToggleIgnore: () => void
  isAnalyzing: boolean
}

function ContentCard({ item, isSelected, index, onSelect, onAnalyze, onToggleStar, onToggleIgnore, isAnalyzing }: ContentCardProps) {
  return (
    <div
      className={`content-card ${isSelected ? 'selected' : ''}`}
      style={{ animationDelay: `${index * 50}ms` }}
      onClick={onSelect}
    >
      <div className="card-header">
        <span className={`type-badge type-${item.type}`}>
          {getTypeIcon(item.type)} {item.type}
        </span>
        <h4>{item.title}</h4>
      </div>
      <div className="card-meta">
        <span>来源: {item.source}</span>
        {item.groupName && <span> → {item.groupName}</span>}
        <span className="card-meta-dot">·</span>
        <span>{item.sourceType}</span>
        <span className="card-meta-dot">·</span>
        <span>{getRelativeTime(item.timestamp)}</span>
      </div>
      <p className="card-summary">{item.summary}</p>
      <div className="card-actions">
        <button
          className="card-action-btn primary"
          onClick={e => { e.stopPropagation(); onAnalyze() }}
          disabled={isAnalyzing}
        >
          {isAnalyzing ? <Loader2 size={14} className="spinning" /> : <Sparkles size={14} />}
          AI深度分析
        </button>
        {item.url && (
          <button
            className="card-action-btn"
            onClick={e => { e.stopPropagation(); window.open(item.url, '_blank') }}
          >
            <ExternalLink size={14} /> 原文链接
          </button>
        )}
        <button
          className={`card-action-btn ${item.starred ? 'active' : ''}`}
          onClick={e => { e.stopPropagation(); onToggleStar() }}
        >
          <Star size={14} /> {item.starred ? '已收藏' : '收藏'}
        </button>
        <button
          className="card-action-btn"
          onClick={e => { e.stopPropagation(); onToggleIgnore() }}
        >
          <EyeOff size={14} /> 忽略
        </button>
      </div>
    </div>
  )
}

export default ContentHubPage
