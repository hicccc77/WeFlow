/**
 * Export Task Store (Zustand)
 *
 * Replaces the event-based ExportBridge with a reactive Zustand store.
 * Used by:
 * - ExportV2Page to publish export session status
 * - Sidebar to subscribe and display active task badge
 * - Other pages to trigger single-export navigation
 */

import { create } from 'zustand'

// ─── Types ───────────────────────────────────────────────────

export interface ExportSessionStatus {
  /** Session IDs that are currently being exported */
  inProgressSessionIds: string[]
  /** Number of active export tasks */
  activeTaskCount: number
}

export interface OpenSingleExportRequest {
  sessionId: string
  sessionName?: string
  requestId: string
  timestamp: number
}

export interface SingleExportDialogStatus {
  requestId: string
  status: 'initializing' | 'opened' | 'failed'
  message?: string
}

export interface ExportTaskStoreState {
  // ── Session status (for Sidebar badge) ──
  sessionStatus: ExportSessionStatus
  setSessionStatus: (status: ExportSessionStatus) => void

  // ── Single export request (other pages → export page) ──
  pendingSingleExport: OpenSingleExportRequest | null
  requestSingleExport: (sessionId: string, sessionName?: string) => string
  consumeSingleExport: () => OpenSingleExportRequest | null

  // ── Single export dialog feedback ──
  lastDialogStatus: SingleExportDialogStatus | null
  setDialogStatus: (status: SingleExportDialogStatus) => void
  clearDialogStatus: () => void
}

// ─── Store ───────────────────────────────────────────────────

let requestSequence = 0

export const useExportTaskStore = create<ExportTaskStoreState>((set, get) => ({
  sessionStatus: {
    inProgressSessionIds: [],
    activeTaskCount: 0
  },

  setSessionStatus: (status) => set({ sessionStatus: status }),

  pendingSingleExport: null,

  requestSingleExport: (sessionId, sessionName) => {
    requestSequence += 1
    const requestId = `single-export-${Date.now()}-${requestSequence}`
    set({
      pendingSingleExport: {
        sessionId,
        sessionName,
        requestId,
        timestamp: Date.now()
      }
    })
    return requestId
  },

  consumeSingleExport: () => {
    const current = get().pendingSingleExport
    if (!current) return null
    set({ pendingSingleExport: null })
    return current
  },

  lastDialogStatus: null,

  setDialogStatus: (status) => set({ lastDialogStatus: status }),

  clearDialogStatus: () => set({ lastDialogStatus: null })
}))
