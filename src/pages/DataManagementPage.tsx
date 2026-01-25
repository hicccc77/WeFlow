import { useEffect, useState } from 'react'
import * as configService from '../services/config'
import './DataManagementPage.scss'

function DataManagementPage() {
  const [dbPath, setDbPath] = useState<string | null>(null)
  const [wxid, setWxid] = useState<string | null>(null)

  useEffect(() => {
    const loadConfig = async () => {
      const [path, id] = await Promise.all([
        configService.getDbPath(),
        configService.getMyWxid()
      ])
      setDbPath(path)
      setWxid(id)
    }
    loadConfig()
    const handleChange = () => {
      loadConfig()
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [])

  return (
    <>
      <div className="page-header">
        <h1>数据管理</h1>
      </div>

      <div className="page-scroll">
        <section className="page-section">
          <div className="section-header">
            <div>
              <h2>WCDB 直连模式</h2>
              <p className="section-desc">
                当前版本通过 WCDB DLL 直接读取加密数据库，不再需要解密流程。
              </p>
            </div>
          </div>

          <div className="database-list">
            <div className="database-item decrypted">
              <div className="db-info">
                <div className="db-name">
                  数据库目录
                </div>
                <div className="db-path">{dbPath || '未配置'}</div>
              </div>
            </div>
            <div className="database-item decrypted">
              <div className="db-info">
                <div className="db-name">
                  微信ID
                </div>
                <div className="db-path">{wxid || '未配置'}</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}

export default DataManagementPage
