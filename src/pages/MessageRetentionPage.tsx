import { useEffect, useState } from 'react'
import { Archive, ChevronLeft, ChevronRight, FolderOpen, ImageOff, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import type { RetainedMessage, RetentionStatus } from '../types/electron'
import './MessageRetentionPage.scss'

const PAGE_SIZE = 30

function formatTime(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '尚未扫描'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}

// Media must be a local raster image inside the archive returned by the main
// process. Message content and rawContent are never interpreted as HTML/URLs.
function archiveImage(mediaPath: string | undefined, archivePath: string | undefined): { path: string; url: string } | null {
  if (!mediaPath || !archivePath) return null
  const normalize = (value: string): string | null => {
    const result = value.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!result || result.includes('\0') || (!/^\/(?!\/)/.test(result) && !/^[a-z]:\//i.test(result))) return null
    if (result.split('/').some(segment => segment === '.' || segment === '..')) return null
    return result
  }
  const file = normalize(mediaPath)
  const root = normalize(archivePath)
  if (!file || !root || !/\.(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(file)) return null
  const windows = /^[a-z]:\//i.test(file)
  const comparableFile = windows ? file.toLowerCase() : file
  const comparableRoot = windows ? root.toLowerCase() : root
  if (!comparableFile.startsWith(`${comparableRoot}/`)) return null
  const encoded = file.split('/').map((segment, index) => windows && index === 0 ? segment : encodeURIComponent(segment)).join('/')
  return { path: file, url: windows ? `file:///${encoded}` : `file://${encoded}` }
}

function SavedImage({ item, archivePath, enabled }: { item: RetainedMessage; archivePath?: string; enabled: boolean }) {
  const source = item.mediaState === 'saved' ? archiveImage(item.mediaPath, archivePath) : null
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source?.url])

  if (source && !failed) {
    return <img className="retention-image" src={source.url} alt="留存的图片" loading="lazy" onError={() => setFailed(true)} />
  }
  if (item.mediaState === 'none') return null
  return (
    <div className="retention-media-note">
      <ImageOff size={16} />
      <span>{item.mediaState === 'pending' ? enabled ? '图片正在尝试保存' : '图片等待保存，自动留存已关闭' : item.mediaState === 'saved' ? '图片暂时无法显示，可打开保存目录查看' : '未能留存图片文件'}</span>
    </div>
  )
}

function MessageRetentionPage({ embedded = false }: { embedded?: boolean }) {
  const [status, setStatus] = useState<RetentionStatus | null>(null)
  const [items, setItems] = useState<RetainedMessage[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [onlyRevoked, setOnlyRevoked] = useState(false)
  const [page, setPage] = useState(0)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim())
      setPage(0)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let cancelled = false
    let pending = false
    setLoading(true)
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const [nextStatus, result] = await Promise.all([
          window.electronAPI.messageRetention.status(),
          window.electronAPI.messageRetention.list({ query, onlyRevoked, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
        ])
        if (cancelled) return
        setStatus(nextStatus)
        setItems(result.items)
        setTotal(result.total)
        setError('')
        const lastPage = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1)
        if (page > lastPage) setPage(lastPage)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '读取留存记录失败，请重试。')
      } finally {
        pending = false
        if (!cancelled) setLoading(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [query, onlyRevoked, page, refreshVersion])

  const changeEnabled = async (enabled: boolean) => {
    setChanging(true)
    setActionError('')
    try {
      setStatus(await window.electronAPI.messageRetention.setEnabled(enabled))
      setRefreshVersion(value => value + 1)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '无法更新留存设置，请重试。')
    } finally {
      setChanging(false)
    }
  }

  const openArchive = async () => {
    if (!status?.archivePath) return
    setActionError('')
    try {
      const result = await window.electronAPI.shell.openPath(status.archivePath)
      if (result) setActionError('无法打开保存目录，请稍后重试。')
    } catch {
      setActionError('无法打开保存目录，请稍后重试。')
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const stateLabel = !status ? '正在读取状态' : !status.enabled ? '已关闭' : status.error ? '留存异常' : status.running ? '正在留存' : '等待连接'
  const count = (value: number | undefined) => value == null ? '—' : value.toLocaleString('zh-CN')

  return (
    <div className={`message-retention-page${embedded ? ' is-embedded' : ''}`}>
      <header className="retention-header">
        <div>
          <h1><ShieldCheck size={25} />消息留存</h1>
          <p>保存本机收到的消息，撤回后仍可查看已留存的副本。</p>
        </div>
        <button className="retention-button" onClick={() => void openArchive()} disabled={!status?.archivePath}>
          <FolderOpen size={16} />打开保存目录
        </button>
      </header>

      <section className="retention-control" aria-label="消息留存设置">
        <div className="retention-control-heading">
          <div>
            <h2>自动留存消息</h2>
            <span className={`retention-status${status?.enabled && status.running && !status.error ? ' is-running' : ''}`} role="status">
              <i aria-hidden="true" />{changing ? '正在更新设置…' : stateLabel}
            </span>
          </div>
          <label className="retention-toggle">
            <input type="checkbox" role="switch" aria-label="自动留存消息" checked={status?.enabled ?? false} disabled={!status || changing} onChange={event => void changeEnabled(event.target.checked)} />
            <span className="retention-toggle-track" aria-hidden="true" />
            <span>{status?.enabled ? '已启用' : '未启用'}</span>
          </label>
        </div>
        <p className="retention-explanation">请保持微信和 WeFlow 运行。只有在撤回前读到的内容才能保留；未捕获的原文会明确标记，不能保证每条消息都被留存。关闭后已有副本仍可查看。</p>
        <p className="retention-explanation">开始留存时会先保存本机近期可读取的消息。媒体目前支持本机可读取的图片和表情，不包含视频、语音及附件内容。</p>
        <div className="retention-stats">
          <div><span>已留存消息</span><strong>{count(status?.totalMessages)}</strong></div>
          <div><span>已识别撤回</span><strong>{count(status?.revokedMessages)}</strong></div>
          <div className="retention-last-scan"><span>最近扫描</span><strong>{status ? formatTime(status.lastScanAt) : '—'}</strong></div>
        </div>
      </section>

      {(error || actionError || status?.error) && <div className="retention-error" role="alert">{actionError || error || status?.error}</div>}

      <section className="retention-records" aria-label="已留存的消息">
        <div className="retention-toolbar">
          <div className="retention-search">
            <Search size={17} aria-hidden="true" />
            <input type="search" aria-label="搜索留存消息" placeholder="搜索消息、会话或发送者" value={search} onChange={event => setSearch(event.target.value)} />
            {search && <button onClick={() => setSearch('')} aria-label="清空搜索"><X size={15} /></button>}
          </div>
          <label className="retention-filter"><input type="checkbox" checked={onlyRevoked} onChange={event => { setOnlyRevoked(event.target.checked); setPage(0) }} />只看撤回</label>
          <button className="retention-button" onClick={() => setRefreshVersion(value => value + 1)} disabled={loading} aria-label="刷新留存消息"><RefreshCw size={16} />刷新</button>
        </div>

        <div className="retention-results-heading"><h2>{onlyRevoked ? '撤回记录' : '留存记录'}</h2><span>{loading ? '正在读取…' : `共 ${count(total)} 条`}</span></div>
        {items.length === 0 ? (
          <div className="retention-empty" role="status">
            <Archive size={32} />
            <h3>{loading ? '正在读取记录' : error ? '暂时无法读取记录' : query || onlyRevoked ? '没有匹配的记录' : '还没有留存记录'}</h3>
            <p>{loading ? '请稍候。' : error ? '请查看上方提示，然后点击刷新重试。' : query || onlyRevoked ? '可调整搜索条件，或取消“只看撤回”。' : status?.enabled ? '保持微信和 WeFlow 运行，收到消息后会自动更新。' : '开启自动留存后，这里会显示成功保存的消息。'}</p>
          </div>
        ) : (
          <div className="retention-list" aria-busy={loading}>
            {items.map(item => (
              <article key={item.id} className={`retention-message${item.recalledAt ? ' is-recalled' : ''}`}>
                <header>
                  <div className="retention-message-identity"><strong>{item.sessionName || '未命名会话'}</strong><span>{item.isSend ? '我' : item.senderName || '未知发送者'}</span></div>
                  <div className="retention-message-meta">
                    {item.recalledAt != null && <span className="retention-recalled-label">检测到撤回</span>}
                    <time>{item.createTime > 0 ? formatTime(item.createTime * 1000) : '时间未知'}</time>
                  </div>
                </header>
                {item.originalMissing ? (
                  <div className="retention-missing"><strong>未捕获原文</strong><p>发现撤回时，原消息已无法读取；此记录不包含原始内容。</p></div>
                ) : (
                  <>
                    <div className="retention-message-content">{item.content || ((item.localType & 0xffff) === 3 ? '[图片]' : '此消息没有可显示的文本')}</div>
                    <SavedImage item={item} archivePath={status?.archivePath} enabled={status?.enabled ?? false} />
                  </>
                )}
                <footer>{item.recalledAt != null ? `检测到撤回：${formatTime(item.recalledAt)}` : `留存于 ${formatTime(item.capturedAt)}`}</footer>
              </article>
            ))}
          </div>
        )}

        <div className="retention-pagination" aria-label="留存记录分页">
          <span>第 {page + 1} / {pageCount} 页</span>
          <button className="retention-button" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} />上一页</button>
          <button className="retention-button" disabled={page + 1 >= pageCount || loading} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16} /></button>
        </div>
      </section>
    </div>
  )
}

export default MessageRetentionPage
