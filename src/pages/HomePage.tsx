import { FolderOpen, ShieldCheck, Sparkles, Waves } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import './HomePage.scss'

function HomePage() {
  const dbPath = useAppStore((state) => state.dbPath)

  return (
    <div className="home-page">
      <div className="home-content">
        <div className="hero">
          <div className="hero-badge">
            <Sparkles size={14} />
            本地私密分析
          </div>
          <h1 className="hero-title">WeFlow</h1>
          <p className="hero-subtitle">把你的聊天记录整理成更清晰的时间脉络与关系图谱</p>
        </div>

        <div className="hero-panels">
          <div className="hero-card">
            <div className="card-icon"><Waves size={18} /></div>
            <div>
              <h3>情感与节奏</h3>
              <p>用时间序列还原对话节奏，发现沉默与高光时刻。</p>
            </div>
          </div>
          <div className="hero-card">
            <div className="card-icon"><ShieldCheck size={18} /></div>
            <div>
              <h3>本地处理</h3>
              <p>数据只在本地完成解析，不上传任何服务器。</p>
            </div>
          </div>
          <div className="hero-card">
            <div className="card-icon"><FolderOpen size={18} /></div>
            <div>
              <h3>当前数据库</h3>
              <p className="card-path">{dbPath || '未检测到路径'}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default HomePage
