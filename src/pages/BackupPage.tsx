import { useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, Database, Download, File, FileArchive, Image, Upload, Video } from 'lucide-react'
import './BackupPage.scss'

type BackupManifest = NonNullable<Awaited<ReturnType<typeof window.electronAPI.backup.inspect>>['manifest']>
type BackupProgress = Parameters<Parameters<typeof window.electronAPI.backup.onProgress>[0]>[0]

function formatDate(value?: string): string {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function summarizeManifest(manifest?: BackupManifest | null) {
  if (!manifest) return { dbCount: 0, tableCount: 0, rowCount: 0, resourceCount: 0 }
  let tableCount = 0
  let rowCount = 0
  for (const db of manifest.databases || []) {
    tableCount += db.tables?.length || 0
    rowCount += (db.tables || []).reduce((sum, table) => sum + (table.rows || 0), 0)
  }
  const resourceCount =
    (manifest.resources?.images?.length || 0) +
    (manifest.resources?.videos?.length || 0) +
    (manifest.resources?.files?.length || 0)
  return { dbCount: manifest.databases?.length || 0, tableCount, rowCount, resourceCount }
}

function BackupPage() {
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedArchive, setSelectedArchive] = useState('')
  const [manifest, setManifest] = useState<BackupManifest | null>(null)
  const [restoreSummary, setRestoreSummary] = useState<{ inserted: number; ignored: number; skipped: number } | null>(null)
  const [resourceOptions, setResourceOptions] = useState({
    includeImages: false,
    includeVideos: false,
    includeFiles: false
  })

  useEffect(() => {
    return window.electronAPI.backup.onProgress(setProgress)
  }, [])

  const summary = useMemo(() => summarizeManifest(manifest), [manifest])
  const percent = progress?.total && progress.total > 0
    ? Math.min(100, Math.round(((progress.current || 0) / progress.total) * 100))
    : (busy ? 8 : 0)

  const handleCreateBackup = async () => {
    if (busy) return
    setBusy(true)
    setProgress(null)
    setMessage('')
    setRestoreSummary(null)
    try {
      const hasResources = resourceOptions.includeImages || resourceOptions.includeVideos || resourceOptions.includeFiles
      const extension = hasResources ? 'tar' : 'tar.gz'
      const defaultPath = `weflow-db-backup-${new Date().toISOString().slice(0, 10)}.${extension}`
      const result = await window.electronAPI.dialog.saveFile({
        title: '保存数据库备份',
        defaultPath,
        filters: [{ name: 'WeFlow 数据库备份', extensions: hasResources ? ['tar'] : ['gz'] }]
      })
      if (result.canceled || !result.filePath) {
        setMessage('已取消')
        return
      }
      const created = await window.electronAPI.backup.create({
        outputPath: result.filePath,
        options: resourceOptions
      })
      if (!created.success) {
        setProgress(null)
        setMessage(created.error || '备份失败')
        return
      }
      setSelectedArchive(created.filePath || result.filePath)
      setManifest(created.manifest || null)
      setMessage('备份完成')
    } catch (error) {
      setProgress(null)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handlePickArchive = async () => {
    if (busy) return
    setBusy(true)
    setProgress(null)
    setMessage('')
    setRestoreSummary(null)
    try {
      const result = await window.electronAPI.dialog.openFile({
        title: '选择数据库备份',
        properties: ['openFile'],
        filters: [
          { name: 'WeFlow 数据库备份', extensions: ['tar', 'gz', 'tgz'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePaths?.[0]) {
        setMessage('已取消')
        return
      }
      const archivePath = result.filePaths[0]
      const inspected = await window.electronAPI.backup.inspect({ archivePath })
      if (!inspected.success) {
        setProgress(null)
        setMessage(inspected.error || '读取备份失败')
        return
      }
      setSelectedArchive(archivePath)
      setManifest(inspected.manifest || null)
      setMessage('备份包已读取')
    } catch (error) {
      setProgress(null)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = async () => {
    if (busy || !selectedArchive) return
    setBusy(true)
    setProgress(null)
    setMessage('')
    setRestoreSummary(null)
    try {
      const restored = await window.electronAPI.backup.restore({ archivePath: selectedArchive })
      if (!restored.success) {
        setProgress(null)
        setMessage(restored.error || '载入失败')
        return
      }
      setRestoreSummary({
        inserted: restored.inserted || 0,
        ignored: restored.ignored || 0,
        skipped: restored.skipped || 0
      })
      setMessage('载入完成')
    } catch (error) {
      setProgress(null)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backup-page">
      <div className="backup-header">
        <div>
          <h1>数据库备份</h1>
          <p>Snapshots 增量备份与载入</p>
        </div>
        <div className="backup-actions">
          <button className="primary-btn" onClick={handleCreateBackup} disabled={busy}>
            <Download size={16} />
            <span>创建备份</span>
          </button>
          <button className="secondary-btn" onClick={handlePickArchive} disabled={busy}>
            <FileArchive size={16} />
            <span>选择备份</span>
          </button>
          <button className="secondary-btn" onClick={handleRestore} disabled={busy || !selectedArchive}>
            <Upload size={16} />
            <span>载入</span>
          </button>
        </div>
      </div>

      <section className="resource-options" aria-label="资源备份选项">
        <label>
          <input
            type="checkbox"
            checked={resourceOptions.includeImages}
            disabled={busy}
            onChange={(event) => setResourceOptions(prev => ({ ...prev, includeImages: event.target.checked }))}
          />
          <Image size={16} />
          <span>图片</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={resourceOptions.includeVideos}
            disabled={busy}
            onChange={(event) => setResourceOptions(prev => ({ ...prev, includeVideos: event.target.checked }))}
          />
          <Video size={16} />
          <span>视频</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={resourceOptions.includeFiles}
            disabled={busy}
            onChange={(event) => setResourceOptions(prev => ({ ...prev, includeFiles: event.target.checked }))}
          />
          <File size={16} />
          <span>文件</span>
        </label>
      </section>

      <div className="backup-status-band">
        <div className="status-icon">
          <ArchiveRestore size={22} />
        </div>
        <div className="status-body">
          <div className="status-title">{progress?.message || message || '等待操作'}</div>
          <div className="status-detail">{progress?.detail || selectedArchive || '未选择备份包'}</div>
          {busy && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
      </div>

      <section className="backup-summary">
        <div className="summary-item">
          <Database size={18} />
          <span>数据库</span>
          <strong>{summary.dbCount}</strong>
        </div>
        <div className="summary-item">
          <Database size={18} />
          <span>表</span>
          <strong>{summary.tableCount}</strong>
        </div>
        <div className="summary-item">
          <Database size={18} />
          <span>行</span>
          <strong>{summary.rowCount.toLocaleString()}</strong>
        </div>
        <div className="summary-item">
          <FileArchive size={18} />
          <span>资源</span>
          <strong>{summary.resourceCount.toLocaleString()}</strong>
        </div>
      </section>

      {manifest && (
        <section className="backup-detail">
          <div className="detail-heading">
            <h2>备份信息</h2>
            <span>{formatDate(manifest.createdAt)}</span>
          </div>
          <div className="detail-grid">
            <div>
              <span>来源账号</span>
              <strong>{manifest.source.wxid || '-'}</strong>
            </div>
            <div>
              <span>版本</span>
              <strong>{manifest.appVersion || '-'}</strong>
            </div>
            <div>
              <span>资源</span>
              <strong>
                图片 {manifest.resources?.images?.length || 0} / 视频 {manifest.resources?.videos?.length || 0} / 文件 {manifest.resources?.files?.length || 0}
              </strong>
            </div>
          </div>
          <div className="db-list">
            {manifest.databases.map(db => (
              <div className="db-row" key={db.id}>
                <span>{db.kind}</span>
                <strong>{db.tables.length} 表</strong>
                <em>{db.relativePath}</em>
              </div>
            ))}
          </div>
        </section>
      )}

      {restoreSummary && (
        <section className="restore-result">
          <div>
            <span>新增</span>
            <strong>{restoreSummary.inserted.toLocaleString()}</strong>
          </div>
          <div>
            <span>已存在</span>
            <strong>{restoreSummary.ignored.toLocaleString()}</strong>
          </div>
          <div>
            <span>跳过</span>
            <strong>{restoreSummary.skipped.toLocaleString()}</strong>
          </div>
        </section>
      )}
    </div>
  )
}

export default BackupPage
