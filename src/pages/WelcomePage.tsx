import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import './WelcomePage.scss'

function WelcomePage() {
  const navigate = useNavigate()
  const { isDbConnected, setDbConnected, setLoading } = useAppStore()
  
  const [dbPath, setDbPath] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [wxid, setWxid] = useState('')
  const [error, setError] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)

  // 选择数据库目录
  const handleSelectPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信数据库目录',
        properties: ['openDirectory']
      })
      
      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择文件失败')
    }
  }

  // 连接数据库
  const handleConnect = async () => {
    if (!dbPath) {
      setError('请先选择数据库目录')
      return
    }
    if (!wxid) {
      setError('请填写微信ID')
      return
    }
    if (!decryptKey || decryptKey.length !== 64) {
      setError('请填写 64 位解密密钥')
      return
    }

    setIsConnecting(true)
    setError('')
    setLoading(true, '正在连接数据库...')

    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)

      if (!result.success) {
        setError(result.error || 'WCDB 连接失败')
        setLoading(false)
        return
      }

      await configService.setDbPath(dbPath)
      await configService.setDecryptKey(decryptKey)
      await configService.setMyWxid(wxid)

      setDbConnected(true, dbPath)
      setLoading(false)
      navigate('/chat')
    } catch (e) {
      setError(`连接失败: ${e}`)
      setLoading(false)
    } finally {
      setIsConnecting(false)
    }
  }

  // 如果已连接，显示已连接状态
  if (isDbConnected) {
    return (
      <div className="welcome-page">
        <div className="welcome-content">
          <h1 className="title">WeFlow</h1>
          <p className="subtitle">数据库已连接</p>
          <button className="btn btn-primary" onClick={() => navigate('/chat')}>
            进入聊天记录
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="welcome-page">
      <div className="welcome-content">
        <h1 className="title">WeFlow</h1>
        <p className="subtitle">探索你的微信数字足迹</p>

        <div className="config-card">
          <div className="config-section">
            <label className="config-label">数据库目录</label>
            <div className="input-group">
              <input
                type="text"
                className="config-input"
                placeholder="选择微信账号目录或 db_storage 父目录"
                value={dbPath}
                onChange={(e) => setDbPath(e.target.value)}
                readOnly
              />
              <button className="btn btn-secondary" onClick={handleSelectPath}>
                选择
              </button>
            </div>
          </div>

          <div className="config-section">
            <label className="config-label">解密密钥</label>
            <input
              type="text"
              className="config-input"
              placeholder="64 位十六进制密钥"
              value={decryptKey}
              onChange={(e) => setDecryptKey(e.target.value)}
            />
          </div>
          <div className="config-section">
            <label className="config-label">微信ID</label>
            <input
              type="text"
              className="config-input"
              placeholder="例如：wxid_xxx"
              value={wxid}
              onChange={(e) => setWxid(e.target.value)}
            />
          </div>

          {error && <div className="error-message">{error}</div>}

          <button
            className="btn btn-primary btn-connect"
            onClick={handleConnect}
            disabled={isConnecting || !dbPath}
          >
            {isConnecting ? '连接中...' : '连接数据库'}
          </button>
        </div>

        <div className="disclaimer">
          <svg className="shield-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span>本工具仅用于个人数据备份查看，请确保拥有合法使用权</span>
        </div>
      </div>
    </div>
  )
}

export default WelcomePage
