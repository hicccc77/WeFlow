import { net } from 'electron'
import type { ConfigService } from './config'

const RELAY_ONE_API_BASE = 'https://aiapi.aiqji.cn/api/v1'
export const RELAY_ONE_GATEWAY_BASE = 'https://aiapi.aiqji.cn/v1'
export const RELAY_ONE_SITE_URL = 'https://aiapi.aiqji.cn'

type RelayOneSession = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

type RelayOneApiEnvelope<T> = {
  code?: number | string
  message?: string
  detail?: string
  data?: T
}

export type RelayOneUser = {
  id: number
  username: string
  email: string
  balance: number
  frozen_balance?: number
  status: 'active' | 'disabled'
  concurrency?: number
  created_at?: string
}

export type RelayOneApiKey = {
  id: number
  key: string
  name: string
  group_id: number | null
  group?: RelayOneGroup
  status: 'active' | 'inactive' | 'quota_exhausted' | 'expired'
  quota: number
  quota_used: number
  last_used_at: string | null
  expires_at: string | null
  created_at: string
}

export type RelayOneGroup = {
  id: number
  name: string
  description?: string
  platform?: string
  subscription_type?: string
  rate_multiplier: number
  user_rate_multiplier?: number
  peak_rate_enabled?: boolean
  peak_start?: string
  peak_end?: string
  peak_rate_multiplier?: number
}

export type RelayOnePaymentMethod = {
  currency?: string
  display_name?: string
  single_min: number
  single_max: number
  fee_rate: number
  available: boolean
}

export type RelayOneCheckoutInfo = {
  methods: Record<string, RelayOnePaymentMethod>
  global_min: number
  global_max: number
  balance_disabled: boolean
  balance_recharge_multiplier: number
  recharge_fee_rate: number
  help_text?: string
}

export type RelayOneOrder = {
  id?: number
  order_id?: number
  amount: number
  pay_amount: number
  currency?: string
  fee_rate?: number
  payment_type?: string
  out_trade_no?: string
  status?: string
  order_type?: string
  pay_url?: string
  qr_code?: string
  client_secret?: string
  expires_at: string
  payment_mode?: string
  resume_token?: string
}

export type RelayOnePublicSettings = {
  registration_enabled: boolean
  email_verify_enabled: boolean
  promo_code_enabled: boolean
  turnstile_enabled: boolean
  registration_email_suffix_whitelist: string[]
  payment_enabled: boolean
  site_name: string
  site_subtitle?: string
  contact_info?: string
  favicon?: string
  login_agreement_enabled?: boolean
  login_agreement_mode?: string
  login_agreement_updated_at?: string
  login_agreement_revision?: string
  login_agreement_documents?: RelayOneAgreementDocument[]
}

export type RelayOneAgreementDocument = {
  id: string
  title: string
  content_md: string
}

type AuthResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  user: RelayOneUser
}

type TotpChallenge = {
  requires_2fa: true
  temp_token: string
  user_email_masked?: string
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  authenticated?: boolean
  retryAfterRefresh?: boolean
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sanitizeUser(value: unknown): RelayOneUser {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    id: finiteNumber(source.id),
    username: normalizedString(source.username),
    email: normalizedString(source.email),
    balance: finiteNumber(source.balance),
    frozen_balance: finiteNumber(source.frozen_balance),
    status: source.status === 'disabled' ? 'disabled' : 'active',
    concurrency: finiteNumber(source.concurrency),
    created_at: normalizedString(source.created_at) || undefined,
  }
}

function sanitizeApiKey(value: unknown): RelayOneApiKey {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const status = ['active', 'inactive', 'quota_exhausted', 'expired'].includes(String(source.status))
    ? source.status as RelayOneApiKey['status']
    : 'inactive'
  return {
    id: finiteNumber(source.id),
    key: normalizedString(source.key),
    name: normalizedString(source.name) || 'RelayOne Key',
    group_id: source.group_id === null || source.group_id === undefined ? null : finiteNumber(source.group_id),
    group: source.group && typeof source.group === 'object' ? sanitizeGroup(source.group) : undefined,
    status,
    quota: finiteNumber(source.quota),
    quota_used: finiteNumber(source.quota_used),
    last_used_at: normalizedString(source.last_used_at) || null,
    expires_at: normalizedString(source.expires_at) || null,
    created_at: normalizedString(source.created_at),
  }
}

function sanitizeGroup(value: unknown): RelayOneGroup {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    id: finiteNumber(source.id),
    name: normalizedString(source.name) || '未命名分组',
    description: normalizedString(source.description) || undefined,
    platform: normalizedString(source.platform) || undefined,
    subscription_type: normalizedString(source.subscription_type) || undefined,
    rate_multiplier: finiteNumber(source.rate_multiplier, 1),
    user_rate_multiplier: source.user_rate_multiplier === undefined
      ? undefined
      : finiteNumber(source.user_rate_multiplier, 1),
    peak_rate_enabled: source.peak_rate_enabled === true,
    peak_start: normalizedString(source.peak_start) || undefined,
    peak_end: normalizedString(source.peak_end) || undefined,
    peak_rate_multiplier: source.peak_rate_multiplier === undefined
      ? undefined
      : finiteNumber(source.peak_rate_multiplier),
  }
}

export class RelayOneService {
  constructor(private readonly config: ConfigService) {}

  private loadSession(): RelayOneSession | null {
    const raw = String(this.config.get('relayOneSessionJson' as any) || '')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<RelayOneSession>
      const accessToken = normalizedString(parsed.accessToken)
      if (!accessToken) return null
      return {
        accessToken,
        refreshToken: normalizedString(parsed.refreshToken) || undefined,
        expiresAt: finiteNumber(parsed.expiresAt) || undefined,
      }
    } catch {
      return null
    }
  }

  private saveSession(session: RelayOneSession | null): void {
    this.config.set('relayOneSessionJson' as any, (session ? JSON.stringify(session) : '') as any)
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const authenticated = options.authenticated === true
    const session = authenticated ? this.loadSession() : null
    if (authenticated && !session?.accessToken) throw new Error('请先登录 RelayOne')

    const response = await net.fetch(`${RELAY_ONE_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN',
        'Content-Type': 'application/json',
        'User-Agent': 'WeFlow/5.0 RelayOne',
        'X-User-UI-Request': '1',
        ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    const contentType = response.headers.get('content-type') || ''
    const raw: unknown = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '')
    const envelope = raw && typeof raw === 'object' ? raw as RelayOneApiEnvelope<T> : null

    if (response.status === 401 && authenticated && options.retryAfterRefresh !== false && session?.refreshToken) {
      const refreshed = await this.refreshSession(session.refreshToken)
      if (refreshed) return this.request<T>(path, { ...options, retryAfterRefresh: false })
    }

    if (!response.ok || (envelope && envelope.code !== undefined && Number(envelope.code) !== 0)) {
      if (response.status === 401 && authenticated) this.saveSession(null)
      const message = normalizedString(envelope?.message)
        || normalizedString(envelope?.detail)
        || (response.status === 401 ? 'RelayOne 登录已失效，请重新登录' : `RelayOne 请求失败（${response.status}）`)
      throw new Error(message)
    }

    if (envelope && 'data' in envelope) return envelope.data as T
    return raw as T
  }

  private async refreshSession(refreshToken: string): Promise<boolean> {
    try {
      const response = await this.request<{ access_token: string; refresh_token?: string; expires_in?: number }>('/auth/refresh', {
        method: 'POST',
        body: { refresh_token: refreshToken },
      })
      const accessToken = normalizedString(response.access_token)
      if (!accessToken) return false
      this.saveSession({
        accessToken,
        refreshToken: normalizedString(response.refresh_token) || refreshToken,
        expiresAt: response.expires_in ? Date.now() + finiteNumber(response.expires_in) * 1000 : undefined,
      })
      return true
    } catch {
      this.saveSession(null)
      return false
    }
  }

  private persistAuth(response: AuthResponse): RelayOneUser {
    const accessToken = normalizedString(response.access_token)
    if (!accessToken) throw new Error('RelayOne 未返回有效登录凭据')
    this.saveSession({
      accessToken,
      refreshToken: normalizedString(response.refresh_token) || undefined,
      expiresAt: response.expires_in ? Date.now() + finiteNumber(response.expires_in) * 1000 : undefined,
    })
    return sanitizeUser(response.user)
  }

  async getPublicSettings(): Promise<RelayOnePublicSettings> {
    const settings = await this.request<RelayOnePublicSettings>('/settings/public')
    const agreementDocuments = Array.isArray(settings.login_agreement_documents)
      ? settings.login_agreement_documents
        .map((value, index) => {
          const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          return {
            id: normalizedString(source.id) || `agreement-${index + 1}`,
            title: normalizedString(source.title) || `平台协议 ${index + 1}`,
            content_md: normalizedString(source.content_md),
          }
        })
        .filter((document) => document.content_md)
      : []
    return {
      registration_enabled: settings.registration_enabled !== false,
      email_verify_enabled: settings.email_verify_enabled === true,
      promo_code_enabled: settings.promo_code_enabled === true,
      turnstile_enabled: settings.turnstile_enabled === true,
      registration_email_suffix_whitelist: Array.isArray(settings.registration_email_suffix_whitelist)
        ? settings.registration_email_suffix_whitelist.map(String)
        : [],
      payment_enabled: settings.payment_enabled === true,
      site_name: normalizedString(settings.site_name) || 'RelayOne',
      site_subtitle: normalizedString(settings.site_subtitle) || undefined,
      contact_info: normalizedString(settings.contact_info) || undefined,
      favicon: normalizedString(settings.favicon) || undefined,
      login_agreement_enabled: settings.login_agreement_enabled === true,
      login_agreement_mode: normalizedString(settings.login_agreement_mode) || undefined,
      login_agreement_updated_at: normalizedString(settings.login_agreement_updated_at) || undefined,
      login_agreement_revision: normalizedString(settings.login_agreement_revision) || undefined,
      login_agreement_documents: agreementDocuments,
    }
  }

  async getStatus(): Promise<{ connected: boolean; user?: RelayOneUser; settings: RelayOnePublicSettings }> {
    const settings = await this.getPublicSettings()
    if (!this.loadSession()) return { connected: false, settings }
    try {
      const user = sanitizeUser(await this.request<RelayOneUser>('/auth/me', { authenticated: true }))
      return { connected: true, user, settings }
    } catch {
      return { connected: false, settings }
    }
  }

  async sendVerificationCode(email: string): Promise<{ message?: string; countdown: number }> {
    const normalizedEmail = normalizedString(email).toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new Error('请输入有效邮箱地址')
    const settings = await this.getPublicSettings()
    if (settings.turnstile_enabled) throw new Error('平台当前要求人机验证，请暂时通过 RelayOne 官网完成注册')
    return this.request('/auth/send-verify-code', { method: 'POST', body: { email: normalizedEmail } })
  }

  async register(input: { email: string; password: string; verifyCode?: string; promoCode?: string }): Promise<RelayOneUser> {
    const email = normalizedString(input.email).toLowerCase()
    const password = String(input.password || '')
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('请输入有效邮箱地址')
    if (password.length < 6) throw new Error('密码至少需要 6 位')
    const settings = await this.getPublicSettings()
    if (settings.turnstile_enabled) throw new Error('平台当前要求人机验证，请暂时通过 RelayOne 官网完成注册')
    const response = await this.request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: {
        email,
        password,
        ...(normalizedString(input.verifyCode) ? { verify_code: normalizedString(input.verifyCode) } : {}),
        ...(normalizedString(input.promoCode) ? { promo_code: normalizedString(input.promoCode) } : {}),
      },
    })
    return this.persistAuth(response)
  }

  async login(input: { email: string; password: string }): Promise<{ user?: RelayOneUser; requires2FA?: boolean; tempToken?: string; emailMasked?: string }> {
    const response = await this.request<AuthResponse | TotpChallenge>('/auth/login', {
      method: 'POST',
      body: { email: normalizedString(input.email).toLowerCase(), password: String(input.password || '') },
    })
    if ((response as TotpChallenge).requires_2fa === true) {
      const challenge = response as TotpChallenge
      return {
        requires2FA: true,
        tempToken: normalizedString(challenge.temp_token),
        emailMasked: normalizedString(challenge.user_email_masked) || undefined,
      }
    }
    return { user: this.persistAuth(response as AuthResponse) }
  }

  async login2FA(input: { tempToken: string; code: string }): Promise<RelayOneUser> {
    const response = await this.request<AuthResponse>('/auth/login/2fa', {
      method: 'POST',
      body: { temp_token: normalizedString(input.tempToken), code: normalizedString(input.code) },
    })
    return this.persistAuth(response)
  }

  async logout(): Promise<void> {
    const session = this.loadSession()
    try {
      if (session?.refreshToken) {
        await this.request('/auth/logout', {
          method: 'POST',
          body: { refresh_token: session.refreshToken },
          authenticated: true,
          retryAfterRefresh: false,
        })
      }
    } finally {
      this.saveSession(null)
    }
  }

  async getAccount(): Promise<RelayOneUser> {
    return sanitizeUser(await this.request<RelayOneUser>('/auth/me', { authenticated: true }))
  }

  async listApiKeys(): Promise<RelayOneApiKey[]> {
    const response = await this.request<{ items?: unknown[]; data?: unknown[] }>('/keys?page=1&page_size=100', { authenticated: true })
    const items = Array.isArray(response)
      ? response
      : Array.isArray(response?.items)
        ? response.items
        : Array.isArray(response?.data)
          ? response.data
          : []
    return items.map(sanitizeApiKey).filter((item) => item.id > 0 && item.key)
  }

  async listGroups(): Promise<RelayOneGroup[]> {
    const [groups, userRates] = await Promise.all([
      this.request<unknown[]>('/groups/available', { authenticated: true }),
      this.request<Record<string, unknown>>('/groups/rates', { authenticated: true })
        .catch((): Record<string, unknown> => ({})),
    ])
    return (Array.isArray(groups) ? groups : [])
      .map((value) => {
        const group = sanitizeGroup(value)
        const rate = userRates?.[String(group.id)]
        return rate === undefined ? group : { ...group, user_rate_multiplier: finiteNumber(rate, group.rate_multiplier) }
      })
      .filter((group) => group.id > 0)
  }

  async createApiKey(input: { name?: string; groupId: number }): Promise<RelayOneApiKey> {
    const groupId = Math.floor(finiteNumber(input?.groupId))
    if (groupId <= 0) throw new Error('请选择 RelayOne API 分组')
    const created = await this.request<RelayOneApiKey>('/keys', {
      method: 'POST',
      authenticated: true,
      body: {
        name: normalizedString(input?.name) || 'WeFlow',
        group_id: groupId,
      },
    })
    return sanitizeApiKey(created)
  }

  async updateApiKeyGroup(input: { keyId: number; groupId: number }): Promise<RelayOneApiKey> {
    const keyId = Math.floor(finiteNumber(input?.keyId))
    const groupId = Math.floor(finiteNumber(input?.groupId))
    if (keyId <= 0) throw new Error('RelayOne API Key 无效')
    if (groupId <= 0) throw new Error('请选择 RelayOne API 分组')
    const updated = await this.request<RelayOneApiKey>(`/keys/${keyId}`, {
      method: 'PUT',
      authenticated: true,
      body: { group_id: groupId },
    })
    return sanitizeApiKey(updated)
  }

  async deleteApiKey(keyIdInput: number): Promise<void> {
    const keyId = Math.floor(finiteNumber(keyIdInput))
    if (keyId <= 0) throw new Error('RelayOne API Key 无效')
    await this.request(`/keys/${keyId}`, { method: 'DELETE', authenticated: true })
  }

  async getCheckoutInfo(): Promise<RelayOneCheckoutInfo> {
    return this.request('/payment/checkout-info', { authenticated: true })
  }

  async createOrder(input: { amount: number; paymentType: string }): Promise<RelayOneOrder> {
    const amount = finiteNumber(input.amount)
    if (amount <= 0) throw new Error('请输入有效充值金额')
    const paymentType = normalizedString(input.paymentType)
    if (!paymentType) throw new Error('请选择支付方式')
    return this.request('/payment/orders', {
      method: 'POST',
      authenticated: true,
      body: {
        amount,
        payment_type: paymentType,
        order_type: 'balance',
        is_mobile: false,
        payment_source: 'hosted_redirect',
        return_url: `${RELAY_ONE_SITE_URL}/payment/result`,
      },
    })
  }

  async getOrder(orderId: number): Promise<RelayOneOrder> {
    const id = Math.floor(finiteNumber(orderId))
    if (id <= 0) throw new Error('订单号无效')
    return this.request(`/payment/orders/${id}`, { authenticated: true })
  }
}
