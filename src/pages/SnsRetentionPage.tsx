import { useEffect, useState } from 'react'
import { Archive, ArrowLeft, Aperture, ChevronLeft, ChevronRight, FolderOpen, Heart, ImageOff, MessageCircle, RefreshCw, Search, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { RetainedSnsMedia, RetainedSnsPost, SnsRetentionStatus } from '../types/electron'
import './SnsRetentionPage.scss'

const PAGE_SIZE = 20

function formatTime(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '尚无记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}

// Only archive-owned raster images and videos may be embedded. Remote URLs,
// markup and media credentials from the original post are never rendered.
function archiveMediaUrl(mediaPath: string | undefined, archivePath: string | undefined, video = false): string | null {
  if (!mediaPath || !archivePath) return null
  const normalize = (value: string): string | null => {
    const result = value.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!result || result.includes('\0') || (!/^\/(?!\/)/.test(result) && !/^[a-z]:\//i.test(result))) return null
    if (result.split('/').some(segment => segment === '.' || segment === '..')) return null
    return result
  }
  const file = normalize(mediaPath)
  const root = normalize(archivePath)
  const extension = video ? /\.(?:mp4|m4v|mov|webm)$/i : /\.(?:jpe?g|png|gif|webp|bmp|avif)$/i
  if (!file || !root || !extension.test(file)) return null
  const windows = /^[a-z]:\//i.test(file)
  const comparableFile = windows ? file.toLowerCase() : file
  const comparableRoot = windows ? root.toLowerCase() : root
  if (!comparableFile.startsWith(`${comparableRoot}/`)) return null
  const encoded = file.split('/').map((part, index) => windows && index === 0 ? part : encodeURIComponent(part)).join('/')
  return windows ? `file:///${encoded}` : `file://${encoded}`
}

function ArchivedMedia({ media, archivePath, enabled }: { media: RetainedSnsMedia; archivePath?: string; enabled: boolean }) {
  const isVideo = (media.kind === 'video' || media.kind === 'livephoto') && media.quality === 'original'
  const source = media.status === 'saved' ? archiveMediaUrl(media.localPath, archivePath, isVideo) : null
  const thumbnail = archiveMediaUrl(media.thumbnailPath, archivePath)
  const [failed, setFailed] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  useEffect(() => { setFailed(false); setPreviewError(false) }, [source])
  const label = media.kind === 'video' ? '视频' : media.kind === 'livephoto' ? '实况照片' : '图片'
  const openImage = async () => {
    if (!source || isVideo) return
    try {
      await window.electronAPI.window.openImageViewerWindow(source)
    } catch {
      setPreviewError(true)
    }
  }

  return (
    <figure className={`sns-retention-media${isVideo ? ' is-video' : ''}`}>
      {source && !failed ? isVideo ? (
        <video src={source} poster={thumbnail || undefined} controls preload="none" onError={() => setFailed(true)} aria-label={`已留存${label}`} />
      ) : (
        <button className="sns-retention-image-button" onClick={() => void openImage()} aria-label={`查看已留存${label}`}>
          <img src={source} loading="lazy" alt={`已留存${label}`} onError={() => setFailed(true)} />
        </button>
      ) : (
        <div className="sns-retention-media-placeholder"><ImageOff size={24} /><span>{failed ? '文件暂时无法显示' : media.status === 'pending' ? `${label}${enabled ? '排队保存中' : '等待保存'}` : `${label}未保存`}</span></div>
      )}
      <figcaption>
        {media.status === 'saved' && source && !failed ? media.quality === 'thumbnail' ? '仅保存缩略图' : `已保存${label}` : media.status === 'pending' ? enabled ? `当前页面的${media.kind === 'image' ? '图片' : '文件'}会优先尝试保存` : '自动留存已关闭，重新启用后可继续尝试' : '原文件不可用或尚未成功保存'}
        {previewError && <span>无法打开预览，可在保存目录查看。</span>}
      </figcaption>
    </figure>
  )
}

function RetainedPost({ item, archivePath, enabled }: { item: RetainedSnsPost; archivePath?: string; enabled: boolean }) {
  return (
    <article className="sns-retention-post">
      <header>
        <div className="sns-retention-author-mark" aria-hidden="true">{(item.nickname || item.username || '友').slice(0, 1)}</div>
        <div className="sns-retention-author"><strong>{item.nickname || item.username || '未知作者'}</strong><time>发布于 {formatTime(item.createTime * 1000)}</time></div>
        <span className="sns-retention-post-badge">已留存</span>
      </header>
      {item.contentDesc && <p className="sns-retention-text">{item.contentDesc}</p>}
      {item.linkTitle && <div className="sns-retention-link-title">分享：{item.linkTitle}</div>}
      {item.media.length > 0 && <div className="sns-retention-media-grid">{item.media.map(media => <ArchivedMedia key={media.id} media={media} archivePath={archivePath} enabled={enabled} />)}</div>}
      {!item.contentDesc && !item.linkTitle && item.media.length === 0 && <p className="sns-retention-no-text">这条动态没有可显示的文字或已保存媒体。</p>}
      {(item.likes.length > 0 || item.comments.length > 0) && (
        <details className="sns-retention-interactions">
          <summary><span><Heart size={14} />{item.likes.length} 个赞</span><span><MessageCircle size={14} />{item.comments.length} 条评论</span><span className="sns-retention-expand-hint">展开查看</span></summary>
          <p className="sns-retention-interactions-note">留存时可见的点赞与评论，可能与当前动态不同。</p>
          {item.likes.length > 0 && <div className="sns-retention-likes"><Heart size={14} /><span>{item.likes.join('、')}</span></div>}
          {item.comments.length > 0 && <ul className="sns-retention-comments">{item.comments.map((comment, index) => <li key={`${comment.id}-${index}`}><strong>{comment.nickname || '未知用户'}</strong>{comment.refNickname && <span> 回复 {comment.refNickname}</span>}：<span>{comment.content || '[非文字评论]'}</span></li>)}</ul>}
        </details>
      )}
      <footer><span>首次留存 {formatTime(item.capturedAt)}</span>{item.snapshotCount > 1 && <span>已保留 {item.snapshotCount} 份快照</span>}<span>最近读取 {formatTime(item.lastSeenAt)}</span></footer>
    </article>
  )
}

export default function SnsRetentionPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<SnsRetentionStatus | null>(null)
  const [items, setItems] = useState<RetainedSnsPost[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [changing, setChanging] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(0) }, 300)
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
          window.electronAPI.snsRetention.status(),
          window.electronAPI.snsRetention.list({ query, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
        ])
        if (cancelled) return
        setStatus(nextStatus)
        setItems(result.items)
        setTotal(result.total)
        setError('')
        const lastPage = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1)
        if (page > lastPage) setPage(lastPage)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '读取朋友圈留存失败，请重试。')
      } finally {
        pending = false
        if (!cancelled) setLoading(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [query, page, refreshVersion])

  const changeEnabled = async (enabled: boolean) => {
    setChanging(true)
    setActionError('')
    try {
      setStatus(await window.electronAPI.snsRetention.setEnabled(enabled))
      setRefreshVersion(value => value + 1)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '无法更新自动留存设置。')
    } finally {
      setChanging(false)
    }
  }

  const scanNow = async () => {
    setScanning(true)
    setActionError('')
    try {
      setStatus(await window.electronAPI.snsRetention.scanNow())
      setRefreshVersion(value => value + 1)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '扫描失败，请稍后重试。')
    } finally {
      setScanning(false)
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

  const count = (value: number | undefined) => value == null ? '—' : value.toLocaleString('zh-CN')
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const running = scanning || status?.running
  const stateLabel = !status ? '正在读取状态' : status.error ? '扫描遇到问题' : running ? '正在扫描本机内容' : status.enabled ? '自动留存已开启' : '自动留存已关闭'

  return (
    <div className="sns-retention-page">
      <header className="sns-retention-header">
        <div><h1><Aperture size={25} />朋友圈留存</h1><p>给本机可见的朋友圈留一份独立副本，已保存内容不会自动过期。</p></div>
        <div className="sns-retention-actions"><button className="sns-retention-button" onClick={() => navigate('/sns')}><ArrowLeft size={16} />返回朋友圈</button><button className="sns-retention-button" onClick={() => void openArchive()} disabled={!status?.archivePath}><FolderOpen size={16} />打开保存目录</button></div>
      </header>

      <section className="sns-retention-control" aria-label="朋友圈留存设置">
        <div className="sns-retention-control-heading">
          <div><h2>自动留存朋友圈</h2><span className={`sns-retention-status${status?.enabled && !status.error ? ' is-active' : ''}`} role="status"><i aria-hidden="true" />{changing ? '正在更新设置…' : stateLabel}</span></div>
          <label className="sns-retention-toggle"><input type="checkbox" role="switch" aria-label="自动留存朋友圈" checked={status?.enabled ?? false} disabled={!status || changing} onChange={event => void changeEnabled(event.target.checked)} /><span className="sns-retention-toggle-track" aria-hidden="true" /><span>{status?.enabled ? '已启用' : '未启用'}</span></label>
        </div>
        <p className="sns-retention-explanation">请保持微信和 WeFlow 运行，并在微信中打开、刷新朋友圈，让新内容下载到本机。这里只留存本机已读取到的可见内容；在捕获前就不可见的动态无法恢复。关闭自动留存后，已有副本仍可查看。</p>
        <p className="sns-retention-explanation">首次批量保存会先显示文字，再在后台尝试保存图片和视频；正在查看的动态会优先处理。原件不可用时，可能只保存缩略图。</p>
        <div className="sns-retention-stats"><div><span>已留存动态</span><strong>{count(status?.totalPosts)}</strong></div><div><span>已保存原件</span><strong>{count(status?.savedMedia)}</strong></div><div><span>待保存媒体</span><strong>{count(status?.pendingMedia)}</strong></div><div><span>原件未保存</span><strong>{count(status?.failedMedia)}</strong></div></div>
        <div className="sns-retention-scan-row"><div><span>最近扫描：{status ? formatTime(status.lastScanAt) : '—'}</span>{status && !status.baselineComplete && <span>首次整理尚未完成{status.baselineOffset > 0 ? `，已检查 ${count(status.baselineOffset)} 条` : ''}</span>}</div><button className="sns-retention-button is-primary" onClick={() => void scanNow()} disabled={!status?.enabled || running || changing}><RefreshCw size={16} className={running ? 'is-spinning' : undefined} />{running ? '扫描中…' : '立即扫描'}</button></div>
      </section>

      {(error || actionError || status?.error) && <div className="sns-retention-error" role="alert">{actionError || error || status?.error}</div>}

      <section className="sns-retention-records" aria-label="已留存的朋友圈">
        <div className="sns-retention-toolbar"><div className="sns-retention-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="搜索留存的朋友圈" placeholder="搜索作者或动态内容" value={search} onChange={event => setSearch(event.target.value)} />{search && <button onClick={() => setSearch('')} aria-label="清空搜索"><X size={15} /></button>}</div><button className="sns-retention-button" onClick={() => setRefreshVersion(value => value + 1)} disabled={loading}><RefreshCw size={16} />刷新列表</button></div>
        <div className="sns-retention-results-heading"><h2>留存的朋友圈</h2><span>{loading ? '正在读取…' : `共 ${count(total)} 条`}</span></div>
        {items.length > 0 ? <div className="sns-retention-list" aria-busy={loading}>{items.map(item => <RetainedPost key={item.id} item={item} archivePath={status?.archivePath} enabled={status?.enabled ?? false} />)}</div> : <div className="sns-retention-empty" role="status"><Archive size={32} /><h3>{loading ? '正在读取记录' : error ? '暂时无法读取记录' : query ? '没有匹配的动态' : '还没有留存的朋友圈'}</h3><p>{loading ? '请稍候。' : error ? '请查看上方提示，稍后刷新重试。' : query ? '试试其他作者或关键词。' : '先在微信中打开、刷新朋友圈，再开启自动留存；需要时可点击“立即扫描”。'}</p></div>}
        <div className="sns-retention-pagination" aria-label="朋友圈留存分页"><span>第 {page + 1} / {pageCount} 页</span><button className="sns-retention-button" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} />上一页</button><button className="sns-retention-button" disabled={page + 1 >= pageCount || loading} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16} /></button></div>
      </section>
    </div>
  )
}
