const MODEL_TOKEN_NAMES: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  claude: 'Claude',
  coder: 'Coder',
  composer: 'Composer',
  deepseek: 'DeepSeek',
  flash: 'Flash',
  gemini: 'Gemini',
  glm: 'GLM',
  gpt: 'GPT',
  grok: 'Grok',
  haiku: 'Haiku',
  instruct: 'Instruct',
  kimi: 'Kimi',
  latest: 'Latest',
  llm: 'LLM',
  minimax: 'MiniMax',
  mini: 'Mini',
  nano: 'Nano',
  openai: 'OpenAI',
  opus: 'Opus',
  preview: 'Preview',
  pro: 'Pro',
  qwen: 'Qwen',
  reasoner: 'Reasoner',
  reasoning: 'Reasoning',
  sol: 'Sol',
  sonnet: 'Sonnet',
  turbo: 'Turbo',
  vision: 'Vision',
}

function formatModelToken(token: string): string {
  if (!token || /^\d+(?:\.\d+)*$/.test(token)) return token
  const mapped = MODEL_TOKEN_NAMES[token.toLowerCase()]
  if (mapped) return mapped
  if (/^[vrmk]\d/i.test(token)) return `${token[0].toUpperCase()}${token.slice(1)}`
  if (/[A-Z]/.test(token.slice(1))) return token
  return `${token[0].toUpperCase()}${token.slice(1)}`
}

/**
 * Formats model IDs for display only. The original ID must still be used for API calls.
 */
export function formatAIModelDisplayName(modelId: string): string {
  return modelId
    .trim()
    .split('/')
    .map((pathPart) => pathPart.split('-').map(formatModelToken).join('-'))
    .join('/')
}
