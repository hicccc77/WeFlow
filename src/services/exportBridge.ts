export interface OpenSingleExportPayload {
  sessionId: string
  sessionName?: string
  requestId?: string
}

export interface ExportSessionStatusPayload {
  inProgressSessionIds: string[]
  activeTaskCount: number
}

export interface SingleExportDialogStatusPayload {
  requestId: string
  status: 'initializing' | 'opened' | 'failed'
  message?: string
}

const OPEN_SINGLE_EXPORT_EVENT = 'weflow:open-single-export'
const EXPORT_SESSION_STATUS_EVENT = 'weflow:export-session-status'
const EXPORT_SESSION_STATUS_REQUEST_EVENT = 'weflow:export-session-status-request'
const SINGLE_EXPORT_DIALOG_STATUS_EVENT = 'weflow:single-export-dialog-status'

export const emitOpenSingleExport = (payload: OpenSingleExportPayload) => {
  window.dispatchEvent(new CustomEvent<OpenSingleExportPayload>(OPEN_SINGLE_EXPORT_EVENT, {
    detail: payload
  }))
}

export const onOpenSingleExport = (
  listener: (payload: OpenSingleExportPayload) => void
): (() => void) => {
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<OpenSingleExportPayload>
    listener(customEvent.detail)
  }

  window.addEventListener(OPEN_SINGLE_EXPORT_EVENT, handler as EventListener)
  return () => window.removeEventListener(OPEN_SINGLE_EXPORT_EVENT, handler as EventListener)
}

export const emitExportSessionStatus = (payload: ExportSessionStatusPayload) => {
  window.dispatchEvent(new CustomEvent<ExportSessionStatusPayload>(EXPORT_SESSION_STATUS_EVENT, {
    detail: payload
  }))
}

export const onExportSessionStatus = (
  listener: (payload: ExportSessionStatusPayload) => void
): (() => void) => {
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<ExportSessionStatusPayload>
    listener(customEvent.detail)
  }

  window.addEventListener(EXPORT_SESSION_STATUS_EVENT, handler as EventListener)
  return () => window.removeEventListener(EXPORT_SESSION_STATUS_EVENT, handler as EventListener)
}

export const requestExportSessionStatus = () => {
  window.dispatchEvent(new CustomEvent(EXPORT_SESSION_STATUS_REQUEST_EVENT))
}

export const onExportSessionStatusRequest = (listener: () => void): (() => void) => {
  const handler = () => listener()
  window.addEventListener(EXPORT_SESSION_STATUS_REQUEST_EVENT, handler)
  return () => window.removeEventListener(EXPORT_SESSION_STATUS_REQUEST_EVENT, handler)
}

export const emitSingleExportDialogStatus = (payload: SingleExportDialogStatusPayload) => {
  window.dispatchEvent(new CustomEvent<SingleExportDialogStatusPayload>(SINGLE_EXPORT_DIALOG_STATUS_EVENT, {
    detail: payload
  }))
}

export const onSingleExportDialogStatus = (
  listener: (payload: SingleExportDialogStatusPayload) => void
): (() => void) => {
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<SingleExportDialogStatusPayload>
    listener(customEvent.detail)
  }

  window.addEventListener(SINGLE_EXPORT_DIALOG_STATUS_EVENT, handler as EventListener)
  return () => window.removeEventListener(SINGLE_EXPORT_DIALOG_STATUS_EVENT, handler as EventListener)
}
