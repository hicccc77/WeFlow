import { useState, useEffect, useRef } from 'react'
import { ArrowRight, Fingerprint, Lock, ScanFace, ShieldCheck } from 'lucide-react'
import './LockScreen.scss'

interface LockScreenProps {
    onUnlock: () => void
    avatar?: string
    useHello?: boolean
}

export default function LockScreen({ onUnlock, avatar, useHello = false }: LockScreenProps) {
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [isVerifying, setIsVerifying] = useState(false)
    const [isUnlocked, setIsUnlocked] = useState(false)
    const [showHello, setShowHello] = useState(false)
    const [helloAvailable, setHelloAvailable] = useState(false)

    // 用于取消 WebAuthn 请求
    const abortControllerRef = useRef<AbortController | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        // 快速检查配置并启动
        quickStartHello()
        inputRef.current?.focus()

        return () => {
            // 组件卸载时取消请求
            abortControllerRef.current?.abort()
        }
    }, [])

    const handleUnlock = () => {
        setIsUnlocked(true)
        setTimeout(() => {
            onUnlock()
        }, 1500)
    }

    const quickStartHello = async () => {
        try {
            if (useHello) {
                setHelloAvailable(true)
                setShowHello(true)
                verifyHello()
            }
        } catch (e) {
            console.error('Quick start hello failed', e)
        }
    }

    const verifyHello = async () => {
        if (isVerifying || isUnlocked) return

        setIsVerifying(true)
        setError('')

        try {
            const result = await window.electronAPI.auth.hello()

            if (result.success) {
                handleUnlock()
            } else {
                console.error('Hello verification failed:', result.error)
                setError(result.error || '验证失败')
            }
        } catch (e: any) {
            console.error('Hello verification error:', e)
            setError(`验证失败: ${e.message || String(e)}`)
        } finally {
            setIsVerifying(false)
        }
    }

    const handlePasswordSubmit = async (e?: React.FormEvent) => {
        e?.preventDefault()
        if (!password || isUnlocked) return

        setIsVerifying(true)
        setError('')

        try {
            // 发送原始密码到主进程，由主进程验证并解密密钥
            const result = await window.electronAPI.auth.unlock(password)

            if (result.success) {
                handleUnlock()
            } else {
                setError(result.error || '密码错误')
                setPassword('')
                setIsVerifying(false)
            }
        } catch (e) {
            setError('验证失败')
            setIsVerifying(false)
        }
    }

    return (
        <div className={`lock-screen ${isUnlocked ? 'unlocked' : ''}`}>
            <div className="lock-content">
                <div className="lock-avatar">
                    {avatar ? (
                        <img src={avatar} alt="User" style={{ width: '100%', height: '100%', borderRadius: '50%' }} />
                    ) : (
                        <Lock size={40} />
                    )}
                </div>

                <h2 className="lock-title">WeFlow 已锁定</h2>

                <form className="lock-form" onSubmit={handlePasswordSubmit}>
                    <div className="input-group">
                        <input
                            ref={inputRef}
                            type="password"
                            placeholder="输入应用密码"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        // 移除 disabled，允许用户随时输入
                        />
                        <button type="submit" className="submit-btn" disabled={!password}>
                            <ArrowRight size={18} />
                        </button>
                    </div>

                    {showHello && (
                        <button
                            type="button"
                            className={`hello-btn ${isVerifying ? 'loading' : ''}`}
                            onClick={verifyHello}
                        >
                            <Fingerprint size={20} />
                            {isVerifying ? '验证中...' : '使用 Windows Hello 解锁'}
                        </button>
                    )}
                </form>

                {error && <div className="lock-error">{error}</div>}
            </div>
        </div>
    )
}
