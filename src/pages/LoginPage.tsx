import { useState, useRef } from 'react'
import { ArrowRight, LogIn } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import './LoginPage.scss'

const HARDCODED_USERNAME = 'admin'
const HARDCODED_PASSWORD = 'admin123'

export default function LoginPage() {
  const setIsLoggedIn = useAppStore(state => state.setIsLoggedIn)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLogging, setIsLogging] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!username || !password) {
      setError('请输入账号和密码')
      return
    }

    setIsLogging(true)
    setError('')

    // 模拟异步验证
    setTimeout(() => {
      if (username === HARDCODED_USERNAME && password === HARDCODED_PASSWORD) {
        setIsSuccess(true)
        setTimeout(() => {
          setIsLoggedIn(true)
        }, 600)
      } else {
        setError('账号或密码错误')
        setPassword('')
        setIsLogging(false)
      }
    }, 300)
  }

  return (
    <div className={`login-screen ${isSuccess ? 'success' : ''}`}>
      <div className="login-content">
        <div className="login-logo">
          <LogIn size={36} />
        </div>

        <h2 className="login-title">浅雨科技人力仓管理系统</h2>
        <p className="login-subtitle">请输入账号密码以继续</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="login-username">账号</label>
            <input
              id="login-username"
              ref={usernameRef}
              type="text"
              placeholder="请输入账号"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError('') }}
              disabled={isLogging}
              autoFocus
            />
          </div>

          <div className="login-field">
            <label htmlFor="login-password">密码</label>
            <input
              id="login-password"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError('') }}
              disabled={isLogging}
            />
          </div>

          <button
            type="submit"
            className={`login-submit-btn ${isLogging ? 'loading' : ''}`}
            disabled={isLogging || !username || !password}
          >
            {isLogging ? '登录中...' : '登录'}
            {!isLogging && <ArrowRight size={16} />}
          </button>
        </form>

        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  )
}
