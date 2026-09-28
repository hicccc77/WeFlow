import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ERROR_CATEGORY_LABELS,
  ERROR_LEVEL_LABELS,
  ERROR_REFERENCE_ENTRIES,
  type ErrorCategory,
  type ErrorReferenceEntry,
} from '../data/errorCatalog'
import { extractErrorCodes } from '../utils/errorReference'
import './ErrorReferencePage.scss'

type CategoryFilter = 'all' | ErrorCategory

const categoryOrder: CategoryFilter[] = ['all', 'session', 'runtime', 'backup', 'common', 'special']
const categoryLabel = (category: CategoryFilter) => category === 'all' ? '全部错误' : ERROR_CATEGORY_LABELS[category]

function ErrorReferenceCard({
  entry,
  initiallyOpen,
  index,
}: {
  entry: ErrorReferenceEntry
  initiallyOpen: boolean
  index: number
}) {
  const [isOpen, setIsOpen] = useState(initiallyOpen)

  return (
    <details
      className={`error-reference-card level-${entry.level}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="error-reference-result-index" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>
        <div className="error-reference-card-main">
          <div className="error-reference-card-overline">
            <code>{entry.codeLabel || entry.codes.join(' / ')}</code>
            <span>{ERROR_CATEGORY_LABELS[entry.category]}</span>
          </div>
          <h3>{entry.title}</h3>
          <p>{entry.summary}</p>
        </div>
        <div className="error-reference-card-meta">
          <span className={`error-reference-level ${entry.level}`}>{ERROR_LEVEL_LABELS[entry.level]}</span>
          <span className="error-reference-chevron" aria-hidden="true" />
        </div>
      </summary>

      <div className="error-reference-detail">
        <div className="error-reference-columns">
          <section className="error-reference-causes">
            <div className="error-reference-detail-heading">
              <h4>可能原因</h4>
            </div>
            <ul>{entry.causes.map((cause) => <li key={cause}>{cause}</li>)}</ul>
          </section>
          <section className="error-reference-actions">
            <div className="error-reference-detail-heading">
              <h4>处理建议</h4>
            </div>
            <ol>{entry.actions.map((action) => <li key={action}>{action}</li>)}</ol>
          </section>
        </div>
      </div>
    </details>
  )
}

function ErrorReferencePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialQuery = searchParams.get('q') || ''
  const [query, setQuery] = useState(initialQuery)
  const [category, setCategory] = useState<CategoryFilter>('all')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setQuery(searchParams.get('q') || '')
  }, [searchParams])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      window.electronAPI.window.close()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const queryCodes = useMemo(() => extractErrorCodes(query), [query])
  const normalizedQuery = query.trim().toLowerCase()
  const queryTokens = useMemo(() => normalizedQuery.split(/\s+/).filter(Boolean), [normalizedQuery])

  const filteredEntries = useMemo(() => ERROR_REFERENCE_ENTRIES.filter((entry) => {
    if (category !== 'all' && entry.category !== category) return false
    if (!normalizedQuery) return true
    if (queryCodes.length > 0) return queryCodes.some((code) => entry.codes.includes(code))

    const haystack = [
      entry.codeLabel,
      entry.codes.join(' '),
      entry.title,
      entry.summary,
      entry.stage,
      ERROR_CATEGORY_LABELS[entry.category],
      ...entry.causes,
      ...entry.actions,
      ...(entry.keywords || []),
    ].filter(Boolean).join(' ').toLowerCase()
    return queryTokens.every((token) => haystack.includes(token))
  }), [category, normalizedQuery, queryCodes, queryTokens])

  const categoryCounts = useMemo(() => ERROR_REFERENCE_ENTRIES.reduce<Record<CategoryFilter, number>>((counts, entry) => {
    counts.all += 1
    counts[entry.category] += 1
    return counts
  }, { all: 0, session: 0, runtime: 0, backup: 0, common: 0, special: 0 }), [])

  const commitSearch = (event?: FormEvent) => {
    event?.preventDefault()
    const next = query.trim()
    setSearchParams(next ? { q: next } : {}, { replace: true })
  }

  const clearSearch = () => {
    setQuery('')
    setSearchParams({}, { replace: true })
    inputRef.current?.focus()
  }

  return (
    <main className="error-reference-page" id="error-reference-main">
      <header className="error-reference-titlebar">
        <strong>报错核对</strong>
        <button
          type="button"
          className="error-reference-window-close"
          onClick={() => window.electronAPI.window.close()}
          aria-label="关闭报错核对窗口"
          title="关闭（Esc）"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="error-reference-content">
        <section className="error-reference-hero" aria-labelledby="error-search-title">
        <div className="error-reference-hero-copy">
          <span className="error-reference-kicker">ERROR REFERENCE</span>
          <h1 id="error-search-title">错误合集<br />找到你的答案。</h1>
          <p>输入错误码或粘贴报错内容，快速核对原因和建议。</p>
        </div>

        <div className="error-reference-search-panel">
          <div className="error-reference-search-panel-head">
            <span>查找这条报错</span>
            <small>{ERROR_REFERENCE_ENTRIES.length} 条说明</small>
          </div>
          <form className="error-reference-search" onSubmit={commitSearch} role="search">
            <label htmlFor="error-reference-query" className="sr-only">搜索错误码或报错内容</label>
            <input
              ref={inputRef}
              id="error-reference-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="错误码、报错内容或关键词"
              autoComplete="off"
            />
            {query && (
              <button type="button" className="error-reference-clear" onClick={clearSearch} aria-label="清空搜索">
                <span aria-hidden="true">×</span>
              </button>
            )}
            <button type="submit" className="error-reference-submit">核对</button>
          </form>
          <div className="error-reference-note">
            <i aria-hidden="true" />
            <span>多个结果时，请结合出错时正在使用的功能判断。</span>
          </div>
        </div>
        </section>

        <div className="error-reference-layout">
        <nav className="error-reference-categories" aria-label="错误类别">
          <div className="error-reference-categories-head">
            <span>错误分类</span>
            <small>FILTER</small>
          </div>
          {categoryOrder.map((item) => {
            return (
              <button
                key={item}
                type="button"
                className={category === item ? 'active' : ''}
                onClick={() => setCategory(item)}
                aria-pressed={category === item}
              >
                <span>{categoryLabel(item)}</span>
                <small>{categoryCounts[item]}</small>
              </button>
            )
          })}
        </nav>

        <section className="error-reference-results" aria-labelledby="error-results-title">
          <div className="error-reference-results-head">
            <div>
              <span className="error-reference-results-kicker">DIAGNOSIS</span>
              <h2 id="error-results-title">核对结果</h2>
            </div>
            <p role="status" aria-live="polite">
              {normalizedQuery ? `找到 ${filteredEntries.length} 条相关说明` : `已收录 ${filteredEntries.length} 条错误说明`}
            </p>
          </div>

          {filteredEntries.length > 0 ? (
            <div className="error-reference-list" key={`results-${category}`}>
              {filteredEntries.map((entry, index) => {
                const exactMatch = queryCodes.some((code) => entry.codes.includes(code))
                return (
                  <ErrorReferenceCard
                    key={`${entry.id}-${normalizedQuery}`}
                    entry={entry}
                    index={index}
                    initiallyOpen={exactMatch || filteredEntries.length === 1}
                  />
                )
              })}
            </div>
          ) : (
            <div className="error-reference-empty" key={`empty-${category}`}>
              <h3>暂未收录这条报错</h3>
              <p>试试只搜索错误码或一个关键词。</p>
              <button type="button" onClick={clearSearch}>查看全部错误</button>
            </div>
          )}
        </section>
        </div>
      </div>
    </main>
  )
}

export default ErrorReferencePage
