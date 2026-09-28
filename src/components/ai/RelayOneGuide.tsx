import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from '@rc-component/qrcode'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import {
  Check,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Mail,
  Plus,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react'
import type {
  RelayOneApiKeyInfo,
  RelayOneCheckoutInfo,
  RelayOneGroupInfo,
  RelayOneOrderInfo,
  RelayOnePublicSettings,
  RelayOneUserInfo,
} from '../../types/electron'
import AIThemedPicker from './AIThemedPicker'

const RELAY_ONE_SITE_URL = 'https://aiapi.aiqji.cn'
const QUICK_AMOUNTS = [20, 50, 100, 200]
const SUCCESS_ORDER_STATUSES = new Set(['PAID', 'RECHARGING', 'COMPLETED'])
const TERMINAL_ORDER_STATUSES = new Set(['COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED', 'REFUNDED'])

type RelayOneGuideProps = {
  configuredApiKey: string
  onApplyApiKey: (apiKey: string) => Promise<void>
}

type Notice = { kind: 'success' | 'error' | 'info'; text: string }
type AuthMode = 'login' | 'register'

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '操作失败')
  return message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 7)}${'•'.repeat(8)}${key.slice(-5)}`
}

function paymentMethodLabel(method: string, displayName?: string): string {
  if (displayName?.trim()) return displayName.trim()
  const labels: Record<string, string> = {
    alipay: '支付宝',
    alipay_direct: '支付宝',
    wxpay: '第三方支付',
    wxpay_direct: '第三方支付',
    stripe: '银行卡',
    airwallex: 'Airwallex',
    easypay: '在线支付',
  }
  return labels[method] || method
}

function platformLabel(platform?: string): string {
  const labels: Record<string, string> = {
    anthropic: 'Claude',
    openai: 'OpenAI',
    gemini: 'Gemini',
    antigravity: 'Antigravity',
    grok: 'Grok',
    composite: '综合模型',
  }
  return labels[platform || ''] || platform || '通用'
}

function groupRate(group: RelayOneGroupInfo): number {
  return Number(group.user_rate_multiplier ?? group.rate_multiplier ?? 1)
}

function orderStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    PENDING: '等待支付',
    PAID: '支付成功',
    RECHARGING: '正在入账',
    COMPLETED: '已到账',
    EXPIRED: '订单已过期',
    CANCELLED: '订单已取消',
    FAILED: '订单失败',
  }
  return labels[String(status || '').toUpperCase()] || '等待支付'
}

function formatMoney(value: number, currency = '$'): string {
  return `${currency}${Number(value || 0).toFixed(2)}`
}

export default function RelayOneGuide({ configuredApiKey, onApplyApiKey }: RelayOneGuideProps) {
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [settings, setSettings] = useState<RelayOnePublicSettings | null>(null)
  const [user, setUser] = useState<RelayOneUserInfo | null>(null)
  const [keys, setKeys] = useState<RelayOneApiKeyInfo[]>([])
  const [groups, setGroups] = useState<RelayOneGroupInfo[]>([])
  const [groupLoadError, setGroupLoadError] = useState('')
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [showKeyCreator, setShowKeyCreator] = useState(false)
  const [editingKeyGroupId, setEditingKeyGroupId] = useState<number | null>(null)
  const [pendingDeleteKeyId, setPendingDeleteKeyId] = useState<number | null>(null)
  const [editedGroupId, setEditedGroupId] = useState<number | null>(null)
  const [keyName, setKeyName] = useState('WeFlow')
  const [checkout, setCheckout] = useState<RelayOneCheckoutInfo | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [verifyCode, setVerifyCode] = useState('')
  const [promoCode, setPromoCode] = useState('')
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [agreementOpen, setAgreementOpen] = useState(false)
  const [selectedAgreementId, setSelectedAgreementId] = useState('')
  const [codeCountdown, setCodeCountdown] = useState(0)
  const [totpToken, setTotpToken] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [totpEmail, setTotpEmail] = useState('')
  const [amount, setAmount] = useState(50)
  const [paymentType, setPaymentType] = useState('')
  const [order, setOrder] = useState<RelayOneOrderInfo | null>(null)
  const pollingRef = useRef<number | null>(null)
  const agreementCloseRef = useRef<HTMLButtonElement | null>(null)

  const selectedKey = useMemo(
    () => keys.find((item) => item.id === selectedKeyId) || keys[0] || null,
    [keys, selectedKeyId],
  )
  const paymentMethods = useMemo(
    () => Object.entries(checkout?.methods || {}).filter(([, method]) => method.available !== false),
    [checkout],
  )
  const groupOptions = useMemo(() => groups.map((group) => ({
    value: String(group.id),
    label: group.name,
    description: [platformLabel(group.platform), group.description].filter(Boolean).join(' · '),
    badge: `${groupRate(group)}x`,
    keywords: `${group.platform || ''} ${group.subscription_type || ''}`,
  })), [groups])
  const keyOptions = useMemo(() => keys.map((key) => {
    const group = key.group || groups.find((item) => item.id === key.group_id)
    return {
      value: String(key.id),
      label: key.name,
      description: `${group?.name || '未标注分组'} · ${maskKey(key.key)}`,
      icon: <KeyRound aria-hidden="true" size={14} />,
      badge: key.key === configuredApiKey ? '使用中' : undefined,
    }
  }), [configuredApiKey, groups, keys])
  const paymentOptions = useMemo(() => paymentMethods.map(([name, method]) => ({
    value: name,
    label: paymentMethodLabel(name, method.display_name),
    description: method.fee_rate > 0 ? `手续费 ${method.fee_rate}%` : '无额外手续费',
    icon: <CircleDollarSign aria-hidden="true" size={14} />,
  })), [paymentMethods])
  const keyApplied = Boolean(selectedKey?.key && selectedKey.key === configuredApiKey)
  const emailValid = /^\S+@\S+\.\S+$/.test(email.trim())
  const registerReady = emailValid
    && password.length >= 6
    && password === confirmPassword
    && acceptedTerms
    && (!settings?.email_verify_enabled || verifyCode.length === 6)
  const authReady = authMode === 'login' ? emailValid && Boolean(password) : registerReady
  const agreementDocuments = settings?.login_agreement_documents || []
  const selectedAgreement = agreementDocuments.find((document) => document.id === selectedAgreementId)
    || agreementDocuments[0]
    || null

  const stopPolling = useCallback(() => {
    if (pollingRef.current !== null) {
      window.clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  const loadConnectedData = useCallback(async (knownUser?: RelayOneUserInfo) => {
    setGroupLoadError('')
    const [accountResult, keysResult, groupsResult, checkoutResult] = await Promise.allSettled([
      knownUser ? Promise.resolve(knownUser) : window.electronAPI.relayOne.getAccount(),
      window.electronAPI.relayOne.listApiKeys(),
      window.electronAPI.relayOne.listGroups(),
      window.electronAPI.relayOne.getCheckoutInfo(),
    ])
    if (accountResult.status === 'fulfilled') setUser(accountResult.value)
    if (keysResult.status === 'fulfilled') {
      setKeys(keysResult.value)
      setShowKeyCreator(keysResult.value.length === 0)
      setSelectedKeyId((current) => (
        keysResult.value.some((item) => item.id === current)
          ? current
          : keysResult.value.find((item) => item.key === configuredApiKey)?.id || keysResult.value[0]?.id || null
      ))
    }
    if (groupsResult.status === 'fulfilled') {
      setGroups(groupsResult.value)
      setSelectedGroupId((current) => (
        groupsResult.value.some((group) => group.id === current)
          ? current
          : groupsResult.value.length === 1 ? groupsResult.value[0].id : null
      ))
    } else {
      setGroupLoadError(errorMessage(groupsResult.reason))
    }
    if (checkoutResult.status === 'fulfilled') {
      setCheckout(checkoutResult.value)
      const methods = Object.entries(checkoutResult.value.methods || {}).filter(([, method]) => method.available !== false)
      setPaymentType((current) => methods.some(([name]) => name === current) ? current : methods[0]?.[0] || '')
      const min = Number(checkoutResult.value.global_min || 0)
      if (min > 0) setAmount((current) => Math.max(current, min))
    }
  }, [configuredApiKey])

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true)
    setNotice(null)
    try {
      const result = await window.electronAPI.relayOne.getStatus()
      setSettings(result.settings)
      setUser(result.connected ? result.user || null : null)
      if (result.connected && result.user) await loadConnectedData(result.user)
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setLoadingStatus(false)
    }
  }, [loadConnectedData])

  useEffect(() => {
    void loadStatus()
    return stopPolling
  }, [loadStatus, stopPolling])

  useEffect(() => {
    if (codeCountdown <= 0) return
    const timer = window.setInterval(() => setCodeCountdown((current) => Math.max(0, current - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [codeCountdown])

  useEffect(() => {
    setEditingKeyGroupId(null)
    setPendingDeleteKeyId(null)
  }, [selectedKeyId])

  useEffect(() => {
    if (!agreementOpen) return
    if (!agreementDocuments.some((document) => document.id === selectedAgreementId)) {
      setSelectedAgreementId(agreementDocuments[0]?.id || '')
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAgreementOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    agreementCloseRef.current?.focus()
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [agreementDocuments, agreementOpen, selectedAgreementId])

  const refreshBalance = async () => {
    setBusy('balance')
    setNotice(null)
    try {
      const account = await window.electronAPI.relayOne.getAccount()
      setUser(account)
      setNotice({ kind: 'success', text: '余额已刷新' })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const refreshGroups = async () => {
    setBusy('groups')
    setGroupLoadError('')
    try {
      const nextGroups = await window.electronAPI.relayOne.listGroups()
      setGroups(nextGroups)
      setSelectedGroupId((current) => (
        nextGroups.some((group) => group.id === current)
          ? current
          : nextGroups.length === 1 ? nextGroups[0].id : null
      ))
    } catch (error) {
      setGroupLoadError(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const sendCode = async () => {
    setBusy('code')
    setNotice(null)
    try {
      const result = await window.electronAPI.relayOne.sendVerificationCode(email)
      setCodeCountdown(Math.max(30, Number(result.countdown || 60)))
      setNotice({ kind: 'success', text: '验证码已发送，请检查邮箱' })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const completeAuth = async (authenticatedUser: RelayOneUserInfo) => {
    setUser(authenticatedUser)
    setPassword('')
    setConfirmPassword('')
    setVerifyCode('')
    setTotpToken('')
    setTotpCode('')
    await loadConnectedData(authenticatedUser)
  }

  const submitAuth = async () => {
    setNotice(null)
    if (authMode === 'register') {
      if (password !== confirmPassword) {
        setNotice({ kind: 'error', text: '两次输入的密码不一致' })
        return
      }
      if (!acceptedTerms) {
        setNotice({ kind: 'error', text: '请先确认 RelayOne 平台协议' })
        return
      }
    }
    setBusy('auth')
    try {
      if (authMode === 'register') {
        const authenticatedUser = await window.electronAPI.relayOne.register({
          email,
          password,
          verifyCode,
          promoCode,
        })
        await completeAuth(authenticatedUser)
        setNotice({ kind: 'success', text: '账户已创建，请选择分组并生成 WeFlow API Key' })
      } else {
        const result = await window.electronAPI.relayOne.login({ email, password })
        if (result.requires2FA) {
          setTotpToken(result.tempToken || '')
          setTotpEmail(result.emailMasked || '')
          setNotice({ kind: 'info', text: '请输入身份验证器中的 6 位验证码' })
        } else if (result.user) {
          await completeAuth(result.user)
          setNotice({ kind: 'success', text: '已连接 RelayOne 账户' })
        }
      }
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const submit2FA = async () => {
    setBusy('auth')
    setNotice(null)
    try {
      const authenticatedUser = await window.electronAPI.relayOne.login2FA({ tempToken: totpToken, code: totpCode })
      await completeAuth(authenticatedUser)
      setNotice({ kind: 'success', text: '已连接 RelayOne 账户' })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const logout = async () => {
    setBusy('logout')
    setNotice(null)
    try {
      await window.electronAPI.relayOne.logout()
      stopPolling()
      setUser(null)
      setKeys([])
      setGroups([])
      setCheckout(null)
      setOrder(null)
      setShowKeyCreator(false)
      setEditingKeyGroupId(null)
      setPendingDeleteKeyId(null)
      setNotice({ kind: 'success', text: '已退出 RelayOne，当前模型 Key 不受影响' })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const applyKey = async (key: RelayOneApiKeyInfo) => {
    setBusy('apply-key')
    setNotice(null)
    try {
      await onApplyApiKey(key.key)
      setNotice({ kind: 'success', text: `${key.name} 已写入当前模型配置` })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const createKey = async () => {
    if (!selectedGroupId) {
      setNotice({ kind: 'error', text: '请先选择 API 分组' })
      return
    }
    setBusy('create-key')
    setNotice(null)
    try {
      const key = await window.electronAPI.relayOne.createApiKey({ name: keyName, groupId: selectedGroupId })
      const selectedGroup = groups.find((group) => group.id === selectedGroupId)
      const normalizedKey = key.group || !selectedGroup ? key : { ...key, group: selectedGroup, group_id: selectedGroup.id }
      setKeys((current) => [normalizedKey, ...current])
      setSelectedKeyId(normalizedKey.id)
      setShowKeyCreator(false)
      await onApplyApiKey(normalizedKey.key)
      setNotice({ kind: 'success', text: 'API Key 已生成并写入当前配置' })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const copyKey = async () => {
    if (!selectedKey?.key) return
    await navigator.clipboard.writeText(selectedKey.key)
    setNotice({ kind: 'success', text: 'API Key 已复制' })
  }

  const beginEditKeyGroup = () => {
    if (!selectedKey) return
    setShowKeyCreator(false)
    setPendingDeleteKeyId(null)
    setEditedGroupId(selectedKey.group_id || selectedKey.group?.id || null)
    setEditingKeyGroupId(selectedKey.id)
  }

  const updateKeyGroup = async () => {
    if (!selectedKey || editingKeyGroupId !== selectedKey.id || !editedGroupId) return
    setBusy('update-key-group')
    setNotice(null)
    try {
      const updated = await window.electronAPI.relayOne.updateApiKeyGroup({ keyId: selectedKey.id, groupId: editedGroupId })
      const group = groups.find((item) => item.id === editedGroupId)
      const normalizedKey = group ? { ...updated, group, group_id: group.id } : updated
      setKeys((current) => current.map((item) => item.id === normalizedKey.id ? normalizedKey : item))
      setEditingKeyGroupId(null)
      setNotice({ kind: 'success', text: `${normalizedKey.name} 已切换到 ${group?.name || '新分组'}` })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const deleteKey = async (key: RelayOneApiKeyInfo) => {
    setBusy('delete-key')
    setNotice(null)
    try {
      await window.electronAPI.relayOne.deleteApiKey(key.id)
      const remaining = keys.filter((item) => item.id !== key.id)
      setKeys(remaining)
      setSelectedKeyId(remaining[0]?.id || null)
      setEditingKeyGroupId(null)
      setPendingDeleteKeyId(null)
      if (remaining.length === 0) setShowKeyCreator(true)
      setNotice({
        kind: key.key === configuredApiKey ? 'info' : 'success',
        text: key.key === configuredApiKey
          ? 'API Key 已删除；当前模型配置仍保留旧值，请写入其他 Key 后继续使用'
          : `${key.name} 已删除`,
      })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const createOrder = async () => {
    setBusy('order')
    setNotice(null)
    stopPolling()
    try {
      const created = await window.electronAPI.relayOne.createOrder({ amount, paymentType })
      setOrder(created)
      const orderId = Number(created.order_id || created.id || 0)
      if (orderId > 0) {
        pollingRef.current = window.setInterval(() => {
          void window.electronAPI.relayOne.getOrder(orderId).then((latest) => {
            setOrder((current) => ({ ...current, ...latest }))
            const status = String(latest.status || '').toUpperCase()
            if (status === 'COMPLETED') {
              stopPolling()
              void window.electronAPI.relayOne.getAccount().then(setUser)
              setNotice({ kind: 'success', text: '充值已到账' })
            } else if (status === 'PAID' || status === 'RECHARGING') {
              setNotice({ kind: 'info', text: '支付成功，余额正在入账' })
            } else if (TERMINAL_ORDER_STATUSES.has(status)) {
              stopPolling()
            }
          }).catch(() => undefined)
        }, 3000)
      }
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const openPayment = () => {
    if (!order) return
    let url = order.pay_url || ''
    if (!url && order.client_secret && (order.order_id || order.id)) {
      const params = new URLSearchParams({
        order_id: String(order.order_id || order.id),
        client_secret: order.client_secret,
      })
      url = `${RELAY_ONE_SITE_URL}/payment/stripe?${params.toString()}`
    }
    if (url) void window.electronAPI.shell.openExternal(url)
  }

  if (loadingStatus) {
    return (
      <section className="relayone-guide form-group" aria-busy="true">
        <div className="relayone-loading"><Loader2 className="is-spinning" size={17} />正在连接 RelayOne…</div>
      </section>
    )
  }

  const suffixes = settings?.registration_email_suffix_whitelist || []
  const hasHostedPayment = Boolean(order?.pay_url || order?.client_secret)
  const orderStatus = String(order?.status || 'PENDING').toUpperCase()
  return (
    <section className="relayone-guide form-group" aria-label="RelayOne 快速接入">
      <header className="relayone-header">
        <div className="relayone-title-line">
          <strong>RelayOne</strong>
          <span className="relayone-recommended">推荐</span>
        </div>
        <button
          className="relayone-icon-button"
          type="button"
          title="打开 RelayOne 官网"
          aria-label="打开 RelayOne 官网"
          onClick={() => { void window.electronAPI.shell.openExternal(RELAY_ONE_SITE_URL) }}
        >
          <ExternalLink size={16} />
        </button>
      </header>

      {notice && (
        <div className={`relayone-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'success' ? <CheckCircle2 size={15} /> : notice.kind === 'error' ? <XCircle size={15} /> : <ShieldCheck size={15} />}
          <span>{notice.text}</span>
        </div>
      )}

      {!user ? (
        <div className="relayone-section relayone-auth-section">
          <div className="relayone-section-heading relayone-auth-heading">
            <div>
              <h3>{authMode === 'register' ? '创建 RelayOne 账户' : '连接已有账户'}</h3>
              <p>{authMode === 'register' ? '注册成功后会自动连接，无需跳转浏览器。' : '使用 RelayOne 邮箱和密码登录。'}</p>
            </div>
            <div className="relayone-segmented" role="tablist" aria-label="账户操作">
              <button aria-selected={authMode === 'register'} role="tab" type="button" onClick={() => { setAuthMode('register'); setTotpToken(''); setNotice(null) }}>注册</button>
              <button aria-selected={authMode === 'login'} role="tab" type="button" onClick={() => { setAuthMode('login'); setTotpToken(''); setNotice(null) }}>登录</button>
            </div>
          </div>

          {settings?.registration_enabled === false && authMode === 'register' ? (
            <div className="relayone-inline-state">
              <XCircle size={18} />
              <div><strong>平台暂时关闭注册</strong><span>已有账户仍可直接登录。</span></div>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setAuthMode('login')}>
                <LogIn size={14} />切换到登录
              </button>
            </div>
          ) : settings?.turnstile_enabled && authMode === 'register' ? (
            <div className="relayone-inline-state">
              <ShieldCheck size={18} />
              <div><strong>平台已启用人机验证</strong><span>请在官网完成注册后返回登录。</span></div>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => { void window.electronAPI.shell.openExternal(`${RELAY_ONE_SITE_URL}/register`) }}>
                <ExternalLink size={14} />打开注册页
              </button>
            </div>
          ) : totpToken ? (
            <form className="relayone-auth-form" onSubmit={(event) => { event.preventDefault(); void submit2FA() }}>
              <label className="relayone-field">
                <span>身份验证器验证码{totpEmail ? ` · ${totpEmail}` : ''}</span>
                <input className="field-input" inputMode="numeric" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 位验证码" />
              </label>
              <button className="btn btn-primary relayone-submit" disabled={busy === 'auth' || totpCode.length !== 6} type="submit">
                {busy === 'auth' ? <Loader2 className="is-spinning" size={15} /> : <ShieldCheck size={15} />}验证并登录
              </button>
            </form>
          ) : (
            <form className="relayone-auth-form" onSubmit={(event) => { event.preventDefault(); void submitAuth() }}>
              <label className="relayone-field">
                <span>邮箱</span>
                <div className="relayone-input-with-icon"><Mail size={15} /><input autoComplete="email" className="field-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></div>
                {authMode === 'register' && suffixes.length > 0 && <small>支持 {suffixes.join('、')}</small>}
              </label>

              {authMode === 'register' && settings?.email_verify_enabled && (
                <label className="relayone-field">
                  <span>邮箱验证码</span>
                  <div className="relayone-code-field">
                    <input className="field-input" inputMode="numeric" maxLength={6} value={verifyCode} onChange={(event) => setVerifyCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 位验证码" />
                    <button className="btn btn-secondary" disabled={busy === 'code' || codeCountdown > 0 || !emailValid} type="button" onClick={() => { void sendCode() }}>
                      {busy === 'code' ? <Loader2 className="is-spinning" size={13} /> : codeCountdown > 0 ? `${codeCountdown}s` : '发送验证码'}
                    </button>
                  </div>
                </label>
              )}

              <label className="relayone-field">
                <span>密码</span>
                <div className="relayone-input-with-action">
                  <input autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} className="field-input" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={authMode === 'register' ? '至少 6 位' : 'RelayOne 登录密码'} />
                  <button aria-label={showPassword ? '隐藏密码' : '显示密码'} title={showPassword ? '隐藏密码' : '显示密码'} type="button" onClick={() => setShowPassword((current) => !current)}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                </div>
              </label>

              {authMode === 'register' && (
                <>
                  <label className="relayone-field">
                    <span>确认密码</span>
                    <input autoComplete="new-password" className="field-input" type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" />
                  </label>
                  {settings?.promo_code_enabled && (
                    <label className="relayone-field">
                      <span>优惠码 <small>选填</small></span>
                      <input className="field-input" value={promoCode} onChange={(event) => setPromoCode(event.target.value)} placeholder="优惠码" />
                    </label>
                  )}
                  <div className="relayone-consent">
                    <label className="relayone-consent-choice">
                      <input checked={acceptedTerms} type="checkbox" onChange={(event) => setAcceptedTerms(event.target.checked)} />
                      <span>我已阅读并同意 RelayOne 平台协议</span>
                    </label>
                    <button type="button" onClick={() => setAgreementOpen(true)}>查看协议</button>
                  </div>
                </>
              )}

              <button className="btn btn-primary relayone-submit" disabled={busy === 'auth' || !authReady} type="submit">
                {busy === 'auth' ? <Loader2 className="is-spinning" size={15} /> : authMode === 'register' ? <UserPlus size={15} /> : <LogIn size={15} />}
                {authMode === 'register' ? '创建账户并连接' : '登录并连接'}
              </button>
            </form>
          )}
        </div>
      ) : (
        <>
          <div className="relayone-account-band">
            <div className="relayone-account-identity">
              <strong>{user.email || user.username}</strong>
            </div>
            <div className="relayone-balance">
              <span>可用余额</span><strong>{formatMoney(user.balance)}</strong>
              {Number(user.frozen_balance || 0) > 0 && <small>冻结 {formatMoney(user.frozen_balance || 0)}</small>}
            </div>
            <div className="relayone-account-actions">
              <button className="relayone-icon-button" disabled={busy === 'balance'} title="刷新余额" aria-label="刷新余额" type="button" onClick={() => { void refreshBalance() }}><RefreshCw className={busy === 'balance' ? 'is-spinning' : ''} size={16} /></button>
              <button className="relayone-icon-button" disabled={busy === 'logout'} title="退出 RelayOne" aria-label="退出 RelayOne" type="button" onClick={() => { void logout() }}><LogOut size={16} /></button>
            </div>
          </div>

          <div className="relayone-section relayone-key-section">
            <div className="relayone-section-heading">
              <div><h3>API Key</h3><p>选择分组后创建 Key，并写入当前模型配置。</p></div>
            </div>

            {keys.length > 0 && (
              <div className="relayone-key-toolbar">
                <div className="relayone-key-select relayone-field">
                  <span>账户中的 Key</span>
                  <AIThemedPicker
                    ariaLabel="选择 RelayOne API Key"
                    className="relayone-key-picker"
                    emptyText="没有可用 API Key"
                    options={keyOptions}
                    placeholder="请选择 API Key"
                    searchable={keys.length > 6}
                    searchPlaceholder="搜索 API Key…"
                    value={selectedKey ? String(selectedKey.id) : ''}
                    onChange={(value) => setSelectedKeyId(Number(value))}
                  />
                </div>
                <div className="relayone-key-actions">
                  <button className="relayone-icon-button" title="复制 API Key" aria-label="复制 API Key" type="button" onClick={() => { void copyKey() }}><Copy size={16} /></button>
                  <button className="relayone-icon-button" disabled={!selectedKey || busy === 'update-key-group'} title="更改 API Key 分组" aria-label="更改 API Key 分组" type="button" onClick={beginEditKeyGroup}><Pencil size={15} /></button>
                  <button className="relayone-icon-button is-danger" disabled={!selectedKey || busy === 'delete-key'} title="删除 API Key" aria-label="删除 API Key" type="button" onClick={() => setPendingDeleteKeyId(selectedKey?.id || null)}><Trash2 size={15} /></button>
                  <button className={`btn ${keyApplied ? 'btn-secondary' : 'btn-primary'}`} disabled={busy === 'apply-key' || keyApplied || !selectedKey} type="button" onClick={() => { if (selectedKey) void applyKey(selectedKey) }}>
                    {busy === 'apply-key' ? <Loader2 className="is-spinning" size={14} /> : keyApplied ? <Check size={14} /> : <KeyRound size={14} />}
                    {keyApplied ? '已写入配置' : '写入当前配置'}
                  </button>
                  <button className="btn btn-secondary" disabled={busy === 'create-key'} type="button" onClick={() => { setEditingKeyGroupId(null); setPendingDeleteKeyId(null); setShowKeyCreator(true) }}><Plus size={14} />新建 Key</button>
                </div>
              </div>
            )}

            {pendingDeleteKeyId && selectedKey?.id === pendingDeleteKeyId && (
              <div className="relayone-delete-confirm" role="alert">
                <Trash2 size={17} />
                <div><strong>删除 {selectedKey.name}？</strong><span>删除后该 Key 会立即失效，无法恢复。</span></div>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setPendingDeleteKeyId(null)}>取消</button>
                <button className="btn btn-danger btn-sm" disabled={busy === 'delete-key'} type="button" onClick={() => { void deleteKey(selectedKey) }}>
                  {busy === 'delete-key' ? <Loader2 className="is-spinning" size={13} /> : <Trash2 size={13} />}确认删除
                </button>
              </div>
            )}

            {editingKeyGroupId && selectedKey?.id === editingKeyGroupId && (
              <div className="relayone-key-creator relayone-key-editor">
                <div className="relayone-key-creator-heading">
                  <div><strong>更改 {selectedKey.name} 的分组</strong><span>保存后立即按新分组的模型范围和倍率计费。</span></div>
                  <button className="relayone-icon-button" aria-label="取消更改分组" title="取消" type="button" onClick={() => setEditingKeyGroupId(null)}><X size={15} /></button>
                </div>
                {groupLoadError ? (
                  <div className="relayone-group-error">
                    <span>{groupLoadError}</span>
                    <button className="btn btn-secondary btn-sm" disabled={busy === 'groups'} type="button" onClick={() => { void refreshGroups() }}>
                      {busy === 'groups' ? <Loader2 className="is-spinning" size={13} /> : <RefreshCw size={13} />}重新加载
                    </button>
                  </div>
                ) : (
                  <AIThemedPicker
                    ariaLabel="更改 RelayOne API Key 分组"
                    className="relayone-group-picker"
                    emptyText="没有可用分组"
                    options={groupOptions}
                    placeholder={groups.length === 0 ? '暂无可用分组' : '请选择分组'}
                    searchPlaceholder="搜索分组…"
                    value={editedGroupId ? String(editedGroupId) : ''}
                    onChange={(value) => setEditedGroupId(Number(value))}
                  />
                )}
                <div className="relayone-key-create-actions">
                  <button className="btn btn-secondary" type="button" onClick={() => setEditingKeyGroupId(null)}>取消</button>
                  <button className="btn btn-primary" disabled={busy === 'update-key-group' || !editedGroupId || editedGroupId === selectedKey.group_id} type="button" onClick={() => { void updateKeyGroup() }}>
                    {busy === 'update-key-group' ? <Loader2 className="is-spinning" size={14} /> : <Check size={14} />}保存分组
                  </button>
                </div>
              </div>
            )}

            {showKeyCreator && (
              <div className="relayone-key-creator">
                <div className="relayone-key-creator-heading">
                  <div><strong>{keys.length === 0 ? '创建第一个 API Key' : '新建 API Key'}</strong><span>Key 创建后会自动写入当前配置。</span></div>
                  {keys.length > 0 && (
                    <button className="relayone-icon-button" aria-label="取消新建 Key" title="取消" type="button" onClick={() => setShowKeyCreator(false)}><X size={15} /></button>
                  )}
                </div>
                <div className="relayone-key-create-grid">
                  <label className="relayone-field">
                    <span>Key 名称</span>
                    <input className="field-input" maxLength={50} value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="WeFlow" />
                  </label>
                  <div className="relayone-field">
                    <span>API 分组</span>
                    {groupLoadError ? (
                      <div className="relayone-group-error">
                        <span>{groupLoadError}</span>
                        <button className="btn btn-secondary btn-sm" disabled={busy === 'groups'} type="button" onClick={() => { void refreshGroups() }}>
                          {busy === 'groups' ? <Loader2 className="is-spinning" size={13} /> : <RefreshCw size={13} />}重新加载
                        </button>
                      </div>
                    ) : (
                      <AIThemedPicker
                        ariaLabel="选择 RelayOne API 分组"
                        className="relayone-group-picker"
                        emptyText="没有可用分组"
                        options={groupOptions}
                        placeholder={groups.length === 0 ? '暂无可用分组' : '请选择分组'}
                        searchPlaceholder="搜索分组…"
                        value={selectedGroupId ? String(selectedGroupId) : ''}
                        onChange={(value) => setSelectedGroupId(Number(value))}
                      />
                    )}
                  </div>
                </div>
                <div className="relayone-key-create-actions">
                  <button className="btn btn-primary" disabled={busy === 'create-key' || !selectedGroupId || !keyName.trim()} type="button" onClick={() => { void createKey() }}>
                    {busy === 'create-key' ? <Loader2 className="is-spinning" size={14} /> : <KeyRound size={14} />}创建并使用
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="relayone-section relayone-recharge-section">
            <div className="relayone-section-heading">
              <div><h3>余额充值</h3><p>订单在 WeFlow 内创建，支付状态和余额会自动刷新。</p></div>
            </div>
            {!settings?.payment_enabled || checkout?.balance_disabled ? (
              <div className="relayone-muted-message">平台当前未开放余额充值。</div>
            ) : paymentMethods.length === 0 ? (
              <div className="relayone-muted-message">当前没有可用支付方式。</div>
            ) : (
              <>
                <div className="relayone-recharge-grid">
                  <fieldset className="relayone-amount-panel">
                    <legend>充值金额</legend>
                    <div className="relayone-amounts" aria-label="快捷金额">
                      {QUICK_AMOUNTS.map((value) => <button className={amount === value ? 'is-selected' : ''} key={value} type="button" onClick={() => setAmount(value)}>¥{value}</button>)}
                    </div>
                    <div className="relayone-amount-input"><span aria-hidden="true">¥</span><input className="relayone-amount-value" aria-label="自定义充值金额" min={checkout?.global_min || 1} max={checkout?.global_max || undefined} step="1" type="number" value={amount} onChange={(event) => setAmount(Number(event.target.value))} /></div>
                    {Boolean((checkout?.global_min || 0) > 0 || (checkout?.global_max || 0) > 0) && (
                      <small>单笔范围 ¥{checkout?.global_min || 1} - ¥{checkout?.global_max || '不限'}</small>
                    )}
                  </fieldset>
                  <div className="relayone-payment-panel">
                    <div className="relayone-field">
                      <span>支付方式</span>
                      <AIThemedPicker
                        ariaLabel="选择 RelayOne 支付方式"
                        className="relayone-payment-picker"
                        emptyText="没有可用支付方式"
                        options={paymentOptions}
                        placeholder="请选择支付方式"
                        searchable={false}
                        value={paymentType}
                        onChange={setPaymentType}
                      />
                    </div>
                    <button className="btn btn-primary relayone-pay-button" disabled={busy === 'order' || amount <= 0 || !paymentType} type="button" onClick={() => { void createOrder() }}>
                      {busy === 'order' ? <Loader2 className="is-spinning" size={15} /> : <CircleDollarSign size={15} />}生成支付订单
                    </button>
                  </div>
                </div>

                {order && (
                  <div className={`relayone-order ${SUCCESS_ORDER_STATUSES.has(orderStatus) ? 'is-paid' : TERMINAL_ORDER_STATUSES.has(orderStatus) ? 'is-failed' : ''}`}>
                    <div className="relayone-order-details">
                      <span className="relayone-order-status">{orderStatusLabel(order.status)}</span>
                      <strong>{formatMoney(order.pay_amount || order.amount, order.currency ? `${order.currency} ` : '¥')}</strong>
                      <span>订单 {order.out_trade_no || order.order_id || order.id}</span>
                      <small>{SUCCESS_ORDER_STATUSES.has(orderStatus) ? '余额会自动刷新' : '支付完成后此处会自动更新'}</small>
                      {hasHostedPayment && !SUCCESS_ORDER_STATUSES.has(orderStatus) && (
                        <button className="btn btn-secondary btn-sm" type="button" onClick={openPayment}><ExternalLink size={14} />打开托管支付</button>
                      )}
                    </div>
                    {order.qr_code && !SUCCESS_ORDER_STATUSES.has(orderStatus) && (
                      <div className="relayone-qr" aria-label="支付二维码">
                        {order.qr_code.startsWith('data:image')
                          ? <img alt="支付二维码" src={order.qr_code} />
                          : <QRCodeSVG bgColor="#ffffff" fgColor="#171717" level="M" size={148} value={order.qr_code} />}
                      </div>
                    )}
                    {SUCCESS_ORDER_STATUSES.has(orderStatus) && <CheckCircle2 className="relayone-order-result" size={44} />}
                    {TERMINAL_ORDER_STATUSES.has(orderStatus) && !SUCCESS_ORDER_STATUSES.has(orderStatus) && <XCircle className="relayone-order-result" size={44} />}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {agreementOpen && createPortal(
        <div
          className="relayone-agreement-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAgreementOpen(false)
          }}
        >
          <section
            aria-labelledby="relayone-agreement-title"
            aria-modal="true"
            className="relayone-agreement-dialog"
            role="dialog"
          >
            <header className="relayone-agreement-header">
              <div>
                <h2 id="relayone-agreement-title">RelayOne 平台协议</h2>
                {settings?.login_agreement_updated_at && (
                  <span>更新于 {settings.login_agreement_updated_at}</span>
                )}
              </div>
              <button
                aria-label="关闭协议"
                className="relayone-agreement-close"
                onClick={() => setAgreementOpen(false)}
                ref={agreementCloseRef}
                title="关闭"
                type="button"
              >
                <X aria-hidden="true" size={17} />
              </button>
            </header>

            {agreementDocuments.length > 0 ? (
              <>
                <div aria-label="协议文档" className="relayone-agreement-tabs" role="tablist">
                  {agreementDocuments.map((document, index) => (
                    <button
                      aria-controls="relayone-agreement-content"
                      aria-selected={document.id === selectedAgreement?.id}
                      key={document.id}
                      onClick={() => setSelectedAgreementId(document.id)}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                        event.preventDefault()
                        const direction = event.key === 'ArrowRight' ? 1 : -1
                        const nextIndex = (index + direction + agreementDocuments.length) % agreementDocuments.length
                        setSelectedAgreementId(agreementDocuments[nextIndex].id)
                        const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                        tabs?.[nextIndex]?.focus()
                      }}
                      role="tab"
                      tabIndex={document.id === selectedAgreement?.id ? 0 : -1}
                      type="button"
                    >
                      {document.title}
                    </button>
                  ))}
                </div>
                <div
                  aria-label={selectedAgreement?.title}
                  className="relayone-agreement-content"
                  id="relayone-agreement-content"
                  role="tabpanel"
                >
                  <ReactMarkdown
                    components={{
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          onClick={(event) => {
                            event.preventDefault()
                            if (href) void window.electronAPI.shell.openExternal(href)
                          }}
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {selectedAgreement?.content_md || ''}
                  </ReactMarkdown>
                </div>
              </>
            ) : (
              <div className="relayone-agreement-empty">RelayOne 当前没有提供可显示的协议内容。</div>
            )}
          </section>
        </div>,
        document.body,
      )}
    </section>
  )
}
