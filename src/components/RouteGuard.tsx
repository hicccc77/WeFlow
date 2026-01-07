import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'

interface RouteGuardProps {
  children: React.ReactNode
}

// 不需要数据库连接的页面
const PUBLIC_ROUTES = ['/', '/settings', '/data-management']

function RouteGuard({ children }: RouteGuardProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const isDbConnected = useAppStore(state => state.isDbConnected)

  useEffect(() => {
    const isPublicRoute = PUBLIC_ROUTES.includes(location.pathname)
    
    // 未连接数据库且不在公开页面，跳转到欢迎页
    if (!isDbConnected && !isPublicRoute) {
      navigate('/', { replace: true })
    }
  }, [isDbConnected, location.pathname, navigate])

  return <>{children}</>
}

export default RouteGuard
