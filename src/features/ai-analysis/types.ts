export type AiAnalysisMediaType = 'text' | 'image' | 'video'

export interface AiAnalysisSettings {
  apiKey: string
  baseUrl: string
  model: string
  preprocessPrompt: string
  mergePrompt: string
  defaultDays: number
  defaultMediaTypes: AiAnalysisMediaType[]
  updatedAt: number
}

export interface AiAnalysisLogEntry {
  id: string
  taskId: string
  level: 'info' | 'warn' | 'error'
  step: string
  message: string
  payload?: unknown
  code?: string
  durationMs?: number
  createdAt: number
}

export interface AiAnalysisTaskRecord {
  id: string
  groupId?: string
  groupName?: string
  rangeStart: number
  rangeEnd: number
  mediaTypes: AiAnalysisMediaType[]
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  errorMessage?: string
  progress?: {
    totalBatches: number
    completedBatches: number
    currentRange?: { start: number; end: number }
  }
  finalResultText?: string
  payloadStats?: {
    selectedMediaTypes: AiAnalysisMediaType[]
    totalFetchedMessages: number
    totalSentMessages: number
    totalSentTextChars: number
    byType: Record<string, number>
  }
  createdAt: number
  updatedAt: number
}
