import type { ExportOptions as ElectronExportOptions } from './electron'

export type ExportAutomationScope = 'single' | 'multi' | 'content'
export type ExportAutomationContentType = 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file'

export type ExportAutomationSchedule =
  | {
      type: 'interval'
      intervalDays: number
      intervalHours: number
      firstTriggerAt?: number
    }

export interface ExportAutomationCondition {
  type: 'new-message-since-last-success'
}

export interface ExportAutomationDateRangeConfig {
  version?: 1
  preset?: string
  useAllTime?: boolean
  start?: string | number | Date | null
  end?: string | number | Date | null
  relativeMode?: 'last-n-days' | string
  relativeDays?: number
}

export interface ExportAutomationTemplate {
  scope: ExportAutomationScope
  contentType?: ExportAutomationContentType
  optionTemplate: Omit<ElectronExportOptions, 'dateRange'>
  dateRangeConfig: ExportAutomationDateRangeConfig | string | null
}

export interface ExportAutomationStopCondition {
  endAt?: number
  maxRuns?: number
}

export type ExportAutomationRunStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'skipped'

export interface ExportAutomationRunState {
  lastRunStatus?: ExportAutomationRunStatus
  lastTriggeredAt?: number
  lastStartedAt?: number
  lastFinishedAt?: number
  lastSuccessAt?: number
  lastSkipAt?: number
  lastSkipReason?: string
  lastError?: string
  lastScheduleKey?: string
  successCount?: number
}

export interface ExportAutomationTask {
  id: string
  name: string
  enabled: boolean
  sessionIds: string[]
  sessionNames: string[]
  outputDir?: string
  schedule: ExportAutomationSchedule
  condition: ExportAutomationCondition
  stopCondition?: ExportAutomationStopCondition
  template: ExportAutomationTemplate
  runState?: ExportAutomationRunState
  createdAt: number
  updatedAt: number
}
