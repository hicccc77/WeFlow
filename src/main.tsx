import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { LoadErrorBoundary } from './components/LoadErrorBoundary'
import './styles/main.scss'

const RelationshipAchievementsDemoPage = React.lazy(() => import('./pages/RelationshipAchievementsPage'))
const ErrorReferencePage = React.lazy(() => import('./pages/ErrorReferencePage'))

const isRelationshipAchievementsDemo = import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('relationship-achievements-demo') === '1'
const isErrorReferenceWindow = window.location.hash.startsWith('#/error-reference-window')

function ErrorReferenceWindowApp() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    let configuredMode = 'system'

    const applyTheme = (themeId: unknown, mode: unknown) => {
      configuredMode = mode === 'light' || mode === 'dark' ? mode : 'system'
      const effectiveMode = configuredMode === 'system'
        ? (media.matches ? 'dark' : 'light')
        : configuredMode
      document.documentElement.setAttribute('data-theme', effectiveMode)
      document.documentElement.setAttribute('data-mode', effectiveMode)
      document.documentElement.setAttribute('data-accent-theme', typeof themeId === 'string' && themeId ? themeId : 'cloud-dancer')
      document.documentElement.classList.toggle('dark', effectiveMode === 'dark')
    }

    void Promise.all([
      window.electronAPI.config.get('themeId'),
      window.electronAPI.config.get('theme'),
    ]).then(([themeId, mode]) => applyTheme(themeId, mode)).catch(() => applyTheme('cloud-dancer', 'system'))

    const handleSystemThemeChange = () => {
      if (configuredMode === 'system') {
        const themeId = document.documentElement.getAttribute('data-accent-theme') || 'cloud-dancer'
        applyTheme(themeId, 'system')
      }
    }
    media.addEventListener('change', handleSystemThemeChange)
    document.title = '报错核对 · WeFlow'
    return () => media.removeEventListener('change', handleSystemThemeChange)
  }, [])

  return (
    <React.Suspense fallback={null}>
      <ErrorReferencePage />
    </React.Suspense>
  )
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <HashRouter>
      {/* 根级兜底：任何未被捕获的渲染错误（包括动态导入失败）都不再让窗口只剩一片背景色 */}
      <LoadErrorBoundary title="应用渲染出错" retryLabel="重新加载" onRetry={() => window.location.reload()}>
        {isErrorReferenceWindow ? (
          <ErrorReferenceWindowApp />
        ) : isRelationshipAchievementsDemo ? (
          <React.Suspense fallback={null}>
            <RelationshipAchievementsDemoPage demo />
          </React.Suspense>
        ) : <App />}
      </LoadErrorBoundary>
    </HashRouter>
  </React.StrictMode>
)
