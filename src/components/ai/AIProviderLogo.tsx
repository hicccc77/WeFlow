import { Anthropic, DeepSeek, Doubao, Gemini, Kimi, Ollama, OpenAI, ProviderIcon, Qwen, SiliconCloud, XiaomiMiMo, XAI, Yuanbao, Zhipu } from '@lobehub/icons'
import { Sparkles } from '@gravity-ui/icons'

type AIProviderLogoProps = {
  providerId?: string
  logo?: string
  alt: string
  className?: string
  size?: number
}

const SUPPORTED_PROVIDER_IDS = new Set([
  'openai',
  'anthropic',
  'minimax',
  'gemini',
  'zhipu',
  'qwen',
  'deepseek',
  'doubao',
  'kimi',
  'ollama',
  'xai',
  'tencent'
])

function iconClassName(className?: string) {
  return ['text-muted-foreground', className].filter(Boolean).join(' ')
}

function normalizeProviderId(providerId?: string) {
  if (!providerId) return ''
  if (providerId === 'custom-responses') return 'openai'
  if (providerId === 'openai-compatible') return 'custom'
  if (providerId === 'tianjige') return 'custom'
  if (providerId === 'relayone') return 'custom'
  if (providerId === 'google') return 'gemini'
  if (providerId === 'alibaba-cn') return 'qwen'
  if (providerId === 'moonshotai-cn') return 'kimi'
  if (providerId === 'siliconflow' || providerId === 'siliconflow-cn') return 'siliconcloud'
  if (providerId === 'tencent-tokenhub') return 'tencent'
  if (providerId === 'xiaomi') return 'xiaomimimo'
  return providerId
}

export default function AIProviderLogo({ providerId, logo, alt, className, size = 24 }: AIProviderLogoProps) {
  const normalizedProviderId = normalizeProviderId(providerId)
  const imageLogo = logo || (normalizedProviderId ? `https://models.dev/logos/${normalizedProviderId}.svg` : '')
  const unifiedClassName = iconClassName(className)

  if (normalizedProviderId === 'custom') {
    return <Sparkles width={size} height={size} className={unifiedClassName} />
  }

  if (normalizedProviderId === 'gemini') {
    return <Gemini size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'kimi') {
    return <Kimi size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'siliconcloud') {
    return <SiliconCloud size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'xiaomimimo') {
    return <XiaomiMiMo size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'tencent') {
    return <Yuanbao size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'openai') {
    return <OpenAI size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'anthropic') {
    return <Anthropic size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'qwen') {
    return <Qwen size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'zhipu') {
    return <Zhipu size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'deepseek') {
    return <DeepSeek size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'doubao') {
    return <Doubao size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'ollama') {
    return <Ollama size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId === 'xai') {
    return <XAI size={size} className={unifiedClassName} color="currentColor" />
  }

  if (normalizedProviderId && SUPPORTED_PROVIDER_IDS.has(normalizedProviderId)) {
    return <ProviderIcon provider={normalizedProviderId} type="mono" forceMono size={size} className={unifiedClassName} />
  }

  if (imageLogo) {
    return (
      <span
        aria-label={alt}
        className={unifiedClassName}
        role="img"
        style={{
          backgroundColor: 'currentColor',
          display: 'inline-block',
          height: size,
          mask: `url("${imageLogo}") center / contain no-repeat`,
          WebkitMask: `url("${imageLogo}") center / contain no-repeat`,
          width: size
        }}
      />
    )
  }

  return null
}
