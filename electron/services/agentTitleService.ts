import { streamText } from 'ai'
import { createAgentModel } from './agentModelAdapter'
import { createAgentTextRedactionSession } from './agentTextRedaction'
import type { AgentModelConfig } from './agentService'

export type AgentTitleResult = {
  title: string
  generated: boolean
  error?: string
}

function fallbackTitle(value: string): string {
  return value
    .replace(/@\S+\[[^\]]+\]/g, '')
    .replace(/[？?。！!，,、：:\s]+/g, ' ')
    .trim()
    .slice(0, 18) || '新对话'
}

function titleSamplingOptions(config: AgentModelConfig): { temperature?: number } {
  const modelId = String(config.model || '').trim().toLocaleLowerCase()
  const openAiReasoningModel = config.protocol === 'openai-responses'
    && /^(?:gpt-5|o[1-4](?:-|$))/.test(modelId)
  const nativeAnthropicModel = config.protocol === 'anthropic'
  const modernClaudeModel = /(?:^|\/)claude-(?:opus-4-(?:[7-9]|\d{2,})|(?:sonnet|opus|haiku|fable|mythos)-(?:[5-9]|\d{2,})(?:-|$))/.test(modelId)
  return openAiReasoningModel || nativeAnthropicModel || modernClaudeModel ? {} : { temperature: 0.2 }
}

function titleErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error || '标题模型调用失败')
}

export function normalizeGeneratedAgentTitle(value: unknown): string | null {
  const envelope = /^\s*<title>([^<>\r\n]+)<\/title>\s*$/iu.exec(String(value || ''))
  if (!envelope) return null
  const title = envelope[1]
    .replace(/^[“”"'《》【】\s]+|[“”"'《》【】。！？!?\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title || title.length < 2 || title.length > 24) return null
  return title
}

/**
 * 使用当前会话的同源模型生成简短中文标题；调用前先脱敏，失败时返回确定性的本地兜底标题。
 * 标题失败不会影响主对话运行。
 */
export async function generateAgentTitle(
  conversationText: string,
  modelConfig?: AgentModelConfig,
): Promise<AgentTitleResult> {
  const textRedaction = createAgentTextRedactionSession()
  const safeConversationText = textRedaction.redactText(String(conversationText || ''))
  const firstUserText = safeConversationText
    .replace(/^(?:用户|User)\s*[:：]\s*/i, '')
    .split(/\n(?:助手|Assistant)\s*[:：]/i)[0]
  const fallback = fallbackTitle(firstUserText)
  const hasApiKey = Boolean(modelConfig?.apiKey) || modelConfig?.provider === 'ollama'
  if (!hasApiKey || !modelConfig?.model || !modelConfig.baseURL) {
    return { title: fallback, generated: false, error: '标题请求缺少可用的同源模型配置' }
  }

  try {
    // 使用与主智能体运行相同的流式传输。一些自定义 OpenAI 兼容网关会终止非流式请求，
    // 但其流式聊天补全端点仍能正常工作。
    const result = streamText({
      model: createAgentModel(modelConfig),
      system: '你负责给 AI 助手的历史会话命名。输出必须严格符合 <title>标题正文</title>，且标签之外不得有任何内容。标题正文使用 8 到 16 个汉字，简洁、具体。',
      prompt: `概括下面会话的核心主题并命名：\n\n${safeConversationText.slice(0, 1800)}`,
      maxOutputTokens: 64,
      ...titleSamplingOptions(modelConfig),
      reasoning: 'none',
    })
    let streamedText = ''
    for await (const delta of result.textStream) streamedText += delta
    const generated = normalizeGeneratedAgentTitle(streamedText)
    if (!generated) {
      const detail = `标题模型未返回正文（finishReason: ${String(await result.finishReason || 'unknown')}）`
      console.warn(`[Agent title] ${modelConfig.provider}/${modelConfig.model}: ${detail}`)
      return { title: fallback, generated: false, error: detail }
    }
    return { title: textRedaction.redactText(generated), generated: true }
  } catch (error) {
    const detail = titleErrorMessage(error)
    console.warn(`[Agent title] ${modelConfig.provider}/${modelConfig.model}: ${detail}`)
    return { title: fallback, generated: false, error: detail }
  }
}
