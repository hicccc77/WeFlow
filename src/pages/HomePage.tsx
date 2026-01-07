import { useNavigate } from 'react-router-dom'
import { MessageSquare, Database, Settings, FileText } from 'lucide-react'
import './HomePage.scss'

function HomePage() {
  const navigate = useNavigate()

  return (
    <div className="home-page">
      <div className="home-content">
        <div className="app-info">
          <img src="./logo.png" alt="WeFlow" className="app-logo" />
          <h1 className="app-name">WeFlow</h1>
          <p className="app-desc">微信聊天记录查看工具</p>
        </div>

        <div className="shortcuts">
          <div className="shortcut-card" onClick={() => navigate('/chat')}>
            <div className="shortcut-icon" style={{ backgroundColor: '#07c160' }}>
              <MessageSquare size={24} />
            </div>
            <span className="shortcut-label">聊天记录</span>
          </div>
          <div className="shortcut-card" onClick={() => navigate('/data-management')}>
            <div className="shortcut-icon" style={{ backgroundColor: '#1989fa' }}>
              <Database size={24} />
            </div>
            <span className="shortcut-label">数据管理</span>
          </div>
          <div className="shortcut-card" onClick={() => navigate('/settings')}>
            <div className="shortcut-icon" style={{ backgroundColor: '#909399' }}>
              <Settings size={24} />
            </div>
            <span className="shortcut-label">设置</span>
          </div>
        </div>

        <div className="tips">
          <h3><FileText size={16} /> 使用提示</h3>
          <ul>
            <li>首次使用请先在「设置」中获取解密密钥</li>
            <li>自动获取时会提示退出重新登陆</li>
            <li>测试链接成功后，到「数据管理」界面解密数据库</li>
            <li>数据仅在本地处理，不会上传到任何服务器</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

export default HomePage
