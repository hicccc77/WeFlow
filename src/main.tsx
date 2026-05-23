import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './styles/main.scss'

const isElectronRuntime = typeof window !== 'undefined' && typeof (window as any).electronAPI !== 'undefined'

const BrowserFallback = () => (
  <div
    style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f172a',
      color: '#e2e8f0',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
      padding: '24px'
    }}
  >
    <div style={{ maxWidth: '720px', textAlign: 'center', lineHeight: 1.7 }}>
      <h1 style={{ marginBottom: '12px', fontSize: '28px' }}>WeFlow 需要在 Electron 桌面环境运行</h1>
      <p style={{ margin: 0, opacity: 0.92 }}>
        当前访问的是 Vite 预览页面，浏览器环境没有注入 electronAPI，核心功能无法初始化。
      </p>
      <p style={{ marginTop: '10px', opacity: 0.8 }}>
        请在本机图形桌面中运行 <code>npm run dev</code> 并打开 Electron 窗口使用。
      </p>
    </div>
  </div>
)

const ElectronApp = () => {
  const LazyApp = React.lazy(() => import('./App'))

  return (
    <React.Suspense fallback={null}>
      <HashRouter>
        <LazyApp />
      </HashRouter>
    </React.Suspense>
  )
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    {isElectronRuntime ? (
      <ElectronApp />
    ) : (
      <BrowserFallback />
    )}
  </React.StrictMode>
)
