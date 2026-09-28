export type BackgroundTaskSourcePage =
  | 'export'
  | 'chat'
  | 'analytics'
  | 'sns'
  | 'groupAnalytics'
  | 'annualReport'
  | 'other'

export type BackgroundTaskStatus =
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface BackgroundTaskRecord {
  id: string
  sourcePage: BackgroundTaskSourcePage
  title: string
  detail?: string
  progressText?: string
  cancelable: boolean
  resumable: boolean
  cancelRequested: boolean
  pauseRequested: boolean
  status: BackgroundTaskStatus
  startedAt: number
  updatedAt: number
  finishedAt?: number
}

export interface BackgroundTaskInput {
  sourcePage: BackgroundTaskSourcePage
  title: string
  detail?: string
  progressText?: string
  cancelable?: boolean
  resumable?: boolean
  onCancel?: () => void | Promise<void>
  onPause?: () => void | Promise<void>
  onResume?: () => void | Promise<void>
}

export interface BackgroundTaskUpdate {
  title?: string
  detail?: string
  progressText?: string
  status?: BackgroundTaskStatus
  cancelable?: boolean
}
