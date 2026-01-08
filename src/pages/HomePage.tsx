import { FolderOpen, ShieldCheck, Sparkles, Waves } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import './HomePage.scss'

function HomePage() {
  return (
    <div className="home-page">
      <div className="home-bg-blobs">
        <div className="blob blob-1"></div>
        <div className="blob blob-2"></div>
        <div className="blob blob-3"></div>
      </div>

      <div className="home-content">
        <div className="hero">
          <h1 className="hero-title">WeFlow</h1>
          <p className="hero-subtitle">每一条消息的背后，都藏着一段温暖的时光</p>
        </div>
      </div>
    </div>
  )
}

export default HomePage
