/**
 * ExportV2 — useExportDialog hook
 *
 * Manages the visibility and state of the Export Configuration dialog.
 * This dialog handles multi-session, single-session, content-specific, and automation-creation intents.
 */

import { useState, useCallback } from 'react'
import type { ExportDialogState, TaskScope, ContentType } from '../types'

export interface ExportDialogResult {
  dialogState: ExportDialogState
  openDialog: (params: Omit<ExportDialogState, 'open'>) => void
  closeDialog: () => void
  openMultiExport: (sessionIds: string[], sessionNames: string[]) => void
  openSingleExport: (sessionId: string, sessionName: string) => void
  openContentExport: (sessionIds: string[], sessionNames: string[], contentType: ContentType) => void
  openAutomationCreate: (sessionIds: string[], sessionNames: string[]) => void
}

export function useExportDialog(): ExportDialogResult {
  const [dialogState, setDialogState] = useState<ExportDialogState>({
    open: false,
    intent: 'manual',
    scope: 'single',
    sessionIds: [],
    sessionNames: [],
    title: ''
  })

  const openDialog = useCallback((params: Omit<ExportDialogState, 'open'>) => {
    setDialogState({
      open: true,
      ...params
    })
  }, [])

  const closeDialog = useCallback(() => {
    setDialogState(prev => ({ ...prev, open: false }))
  }, [])

  const openMultiExport = useCallback((sessionIds: string[], sessionNames: string[]) => {
    openDialog({
      intent: 'manual',
      scope: 'multi',
      sessionIds,
      sessionNames,
      title: `批量导出 (${sessionIds.length} 个会话)`
    })
  }, [openDialog])

  const openSingleExport = useCallback((sessionId: string, sessionName: string) => {
    openDialog({
      intent: 'manual',
      scope: 'single',
      sessionIds: [sessionId],
      sessionNames: [sessionName],
      title: `导出: ${sessionName}`
    })
  }, [openDialog])

  const openContentExport = useCallback((sessionIds: string[], sessionNames: string[], contentType: ContentType) => {
    openDialog({
      intent: 'manual',
      scope: 'content',
      contentType,
      sessionIds,
      sessionNames,
      title: `批量导出特定内容 (${sessionIds.length} 个会话)`
    })
  }, [openDialog])

  const openAutomationCreate = useCallback((sessionIds: string[], sessionNames: string[]) => {
    openDialog({
      intent: 'automation-create',
      scope: sessionIds.length === 1 ? 'single' : 'multi',
      sessionIds,
      sessionNames,
      title: `创建自动化导出任务`
    })
  }, [openDialog])

  return {
    dialogState,
    openDialog,
    closeDialog,
    openMultiExport,
    openSingleExport,
    openContentExport,
    openAutomationCreate
  }
}
