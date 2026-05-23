import type { AiAnalysisSettings } from './types'

export const AI_ANALYSIS_DEFAULTS: AiAnalysisSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  preprocessPrompt: '请从当前批次聊天记录中提取关键结构化信息，输出 JSON。',
  mergePrompt: '请将所有批次结果合并去重，输出最终结构化分析结果（JSON）。',
  defaultDays: 30,
  defaultMediaTypes: ['text'],
  updatedAt: 0
}

export const AI_ANALYSIS_LOG_RETENTION_DAYS = 15
