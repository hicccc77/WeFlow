/**
 * ExportPage — Main page container
 *
 * This is the top-level component for the refactored Export page.
 * It composes sub-components and hooks, keeping itself lean (<300 lines target).
 */

import { memo, useEffect, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import ExportTopBar from './components/ExportTopBar'
import SessionTable from './components/SessionTable'
import ExportDialog from './components/ExportDialog'
import TaskCenter from './components/TaskCenter'
import { ExportDefaultsSettingsForm, type ExportDefaultsSettingsPatch } from '../../components/Export/ExportDefaultsSettingsForm'
import { X } from 'lucide-react'

import { useContactsLoader } from './hooks/useContactsLoader'
import { useExportSessions } from './hooks/useExportSessions'
import { useExportConfig } from './hooks/useExportConfig'
import { useExportDialog } from './hooks/useExportDialog'
import { useExportTasks } from './hooks/useExportTasks'
import { useBackgroundTasks } from './hooks/useBackgroundTasks'
import { useSessionMetrics } from './hooks/useSessionMetrics'
import { useAutomationRunner, useAutomationStore } from './hooks/useAutomation'
import { AutomationModal } from './components/Automation/AutomationModal'
import { AutomationTaskForm } from './components/Automation/AutomationTaskForm'

import type { TextExportFormat } from './types'
import { getSelectionScopeFromRows, resolveScopeDisplayNames } from './utils/session'
import { serializeExportDateRangeConfig } from '../../utils/exportDateRange'
import { displayNameOrFallback, pickDisplayName } from '../../utils/displayName'
import {
  emitSingleExportDialogStatus,
  onOpenSingleExport,
  type OpenSingleExportPayload
} from '../../services/exportBridge'
import './ExportPage.scss'

function ExportPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const isExportRoute = location.pathname === '/export'

  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [isAutomationModalOpen, setIsAutomationModalOpen] = useState(false)
  const [draftAutomationPayload, setDraftAutomationPayload] = useState<any>(null)
  const [pendingSingleExportRequest, setPendingSingleExportRequest] = useState<OpenSingleExportPayload | null>(null)
  const [metricsMapForSort, setMetricsMapForSort] = useState<Record<string, any>>({})

  const { 
    isLoaded: isConfigLoaded,
    options, 
    updateOptions,
    exportPath,
    setExportPath,
    writeLayout,
    setWriteLayout,
    rawDateRangeConfig,
    setRawDateRangeConfig
  } = useExportConfig()

  // ── 2. Load contacts and sessions ──
  const {
    contactMap,
    isLoading: isContactsLoading,
    loadContacts,
    abort: abortContacts
  } = useContactsLoader()

  // ── 3. Metrics ──
  const { metricsMap, fetchMetrics, loadingRefs } = useSessionMetrics()

  const {
    sessions,
    filteredSessions,
    isLoading: isSessionsLoading,
    error: sessionsError,
    activeTab,
    setActiveTab,
    searchQuery,
    setSearchQuery,
    loadSessions,
    sortConfig,
    setSortConfig
  } = useExportSessions(contactMap, 'private', loadingRefs.size > 0 ? metricsMapForSort : metricsMap)

  // Initial load
  useEffect(() => {
    if (!isExportRoute) return
    loadContacts('all')
    loadSessions()
    return () => abortContacts()
  }, [isExportRoute, loadContacts, loadSessions, abortContacts])

  // Use filteredSessions directly (hook already handles tab + search filtering)
  const displayedSessions = filteredSessions

  useEffect(() => {
    if (loadingRefs.size === 0) {
      setMetricsMapForSort(metricsMap)
    }
  }, [loadingRefs.size, metricsMap])

  useEffect(() => {
    if (selectedSessionIds.size === 0) return
    const visibleIds = new Set(displayedSessions.map(session => session.username))
    const nextSelectedIds = new Set(Array.from(selectedSessionIds).filter(id => visibleIds.has(id)))
    if (nextSelectedIds.size !== selectedSessionIds.size) {
      setSelectedSessionIds(nextSelectedIds)
    }
  }, [displayedSessions, selectedSessionIds])

  useEffect(() => {
    if (displayedSessions.length > 0) {
      // Fetch metrics for displayed sessions (in chunks if needed, here we just pass all)
      fetchMetrics(displayedSessions.map(s => s.username))
    }
  }, [displayedSessions, fetchMetrics])

  const handleRefreshStats = useCallback(() => {
    if (displayedSessions.length === 0 || loadingRefs.size > 0) return
    void fetchMetrics(displayedSessions.map(s => s.username), { forceRefresh: true })
  }, [displayedSessions, fetchMetrics, loadingRefs.size])

  // ── 4. Manage Tasks ──
  const {
    tasks: exportTasks,
    startTask,
    cancelTask: cancelExportTask,
    clearCompletedTasks: clearCompletedExportTasks
  } = useExportTasks()

  const { enqueueAutomationTask } = useAutomationRunner(startTask)
  const { addTask } = useAutomationStore()

  const {
    allTasks: backgroundTasks,
    pauseTask: pauseBgTask,
    resumeTask: resumeBgTask,
    cancelTask: cancelBgTask,
    clearSettledTasks: clearSettledBgTasks
  } = useBackgroundTasks()
  const taskCenterBackgroundTasks = backgroundTasks.filter(task => task.sourcePage === 'export' || task.sourcePage === 'chat')

  const clearCompletedTaskCenterBackgroundTasks = useCallback(() => {
    clearSettledBgTasks(task => task.sourcePage === 'export' || task.sourcePage === 'chat')
  }, [clearSettledBgTasks])

  // ── 4. Dialog & Exports ──
  const { dialogState, openDialog, closeDialog } = useExportDialog()

  const resolveSingleExportName = useCallback((payload: OpenSingleExportPayload) => {
    const sessionId = String(payload.sessionId || '').trim()
    const payloadName = pickDisplayName(payload.sessionName)
    const sessionRow = sessions.find(s => s.username === sessionId)
    if (options.displayNamePreference === 'nickname') {
      return displayNameOrFallback(sessionId, sessionRow?.nickname, payloadName, sessionRow?.remark, sessionRow?.displayName)
    }
    return displayNameOrFallback(sessionId, payloadName, sessionRow?.displayName, sessionRow?.remark, sessionRow?.nickname)
  }, [options.displayNamePreference, sessions])

  const handleExportDefaultsChanged = useCallback((patch: ExportDefaultsSettingsPatch) => {
    updateOptions({
      ...(patch.format ? { format: patch.format as TextExportFormat } : {}),
      ...(patch.avatars !== undefined ? { exportAvatars: patch.avatars } : {}),
      ...(patch.fileNamingMode !== undefined ? { fileNamingMode: patch.fileNamingMode } : {}),
      ...(patch.displayNamePreference !== undefined ? { displayNamePreference: patch.displayNamePreference } : {}),
      ...(patch.media ? {
        exportImages: patch.media.images,
        exportVideos: patch.media.videos,
        exportVoices: patch.media.voices,
        exportEmojis: patch.media.emojis,
        exportFiles: patch.media.files,
        maxFileSizeMb: patch.media.maxFileSizeMb
      } : {}),
      ...(patch.voiceAsText !== undefined ? { exportVoiceAsText: patch.voiceAsText } : {}),
      ...(patch.excelCompactColumns !== undefined ? { excelCompactColumns: patch.excelCompactColumns } : {}),
      ...(patch.concurrency !== undefined ? { exportConcurrency: patch.concurrency } : {}),
    })

    if (patch.dateRange) {
      setRawDateRangeConfig(serializeExportDateRangeConfig(patch.dateRange))
    }
  }, [setRawDateRangeConfig, updateOptions])

  const handleExportSelected = useCallback(() => {
    const selectedRows = displayedSessions.filter(s => selectedSessionIds.has(s.username))
    if (selectedRows.length === 0) return

    const scope = getSelectionScopeFromRows(selectedRows)
    const sessionNames = resolveScopeDisplayNames(selectedRows, options.displayNamePreference)
    
    openDialog({
      scope,
      intent: 'manual',
      sessionIds: selectedRows.map(s => s.username),
      sessionNames,
      title: '批量导出'
    })
  }, [displayedSessions, selectedSessionIds, options.displayNamePreference, openDialog])

  const handleAutomationExportFromSelection = useCallback(() => {
    const selectedRows = displayedSessions.filter(s => selectedSessionIds.has(s.username))
    if (selectedRows.length === 0) return

    const scope = getSelectionScopeFromRows(selectedRows)
    const sessionNames = resolveScopeDisplayNames(selectedRows, options.displayNamePreference)
    
    // B-plan: skip ExportDialog, go directly to AutomationTaskForm
    setDraftAutomationPayload({
      sessionIds: selectedRows.map(s => s.username),
      sessionNames,
      scope,
      options
    })
  }, [displayedSessions, selectedSessionIds, options])

  const handleSingleExport = useCallback((sessionId: string) => {
    const sessionRow = displayedSessions.find(s => s.username === sessionId)
    if (!sessionRow) return
    setSelectedSessionIds(new Set([sessionId]))
    
    const scope = getSelectionScopeFromRows([sessionRow])
    const sessionNames = resolveScopeDisplayNames([sessionRow], options.displayNamePreference)

    openDialog({
      scope,
      intent: 'manual',
      sessionIds: [sessionId],
      sessionNames,
      title: '导出联系人/群聊'
    })
  }, [displayedSessions, options.displayNamePreference, openDialog])

  const handleOpenSingleExportRequest = useCallback((payload: OpenSingleExportPayload) => {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : ''
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''

    if (!requestId || !sessionId) {
      if (requestId) {
        emitSingleExportDialogStatus({
          requestId,
          status: 'failed',
          message: '无法打开导出配置：缺少会话信息'
        })
      }
      return
    }

    emitSingleExportDialogStatus({ requestId, status: 'initializing' })

    if (!isConfigLoaded) {
      setPendingSingleExportRequest({
        ...payload,
        requestId,
        sessionId
      })
      return
    }

    const sessionName = resolveSingleExportName(payload)
    setSelectedSessionIds(new Set([sessionId]))
    setActiveTab(sessionId.includes('@chatroom') ? 'group' : 'private')
    navigate('/export')

    openDialog({
      intent: 'manual',
      scope: 'single',
      sessionIds: [sessionId],
      sessionNames: [sessionName],
      title: `导出: ${sessionName}`
    })

    emitSingleExportDialogStatus({ requestId, status: 'opened' })
  }, [isConfigLoaded, navigate, openDialog, resolveSingleExportName, setActiveTab])

  useEffect(() => {
    return onOpenSingleExport(handleOpenSingleExportRequest)
  }, [handleOpenSingleExportRequest])

  useEffect(() => {
    if (!isConfigLoaded || !pendingSingleExportRequest) return
    setPendingSingleExportRequest(null)
    handleOpenSingleExportRequest(pendingSingleExportRequest)
  }, [handleOpenSingleExportRequest, isConfigLoaded, pendingSingleExportRequest])

  const handleConfirmExport = useCallback((finalOptions: any) => {
    updateOptions(finalOptions)
    startTask({
      sessionIds: dialogState.sessionIds,
      sessionNames: dialogState.sessionNames,
      scope: dialogState.scope,
      source: 'manual',
      outputDir: exportPath,
      options: finalOptions
    })
    closeDialog()
  }, [dialogState, exportPath, startTask, closeDialog, updateOptions])

  const handleAutomationCreateFromDialog = useCallback((finalOptions: any) => {
    updateOptions(finalOptions)
    setDraftAutomationPayload({
      sessionIds: dialogState.sessionIds,
      sessionNames: dialogState.sessionNames,
      scope: dialogState.scope,
      contentType: dialogState.contentType,
      outputDir: exportPath,
      options: finalOptions
    })
    closeDialog()
  }, [closeDialog, dialogState, exportPath, updateOptions])

  const handleAutomationSave = useCallback((task: any) => {
    void addTask(task)
    setDraftAutomationPayload(null)
  }, [addTask])

  return (
    <div className="export-v2-page">
      <ExportTopBar 
        exportPath={exportPath}
        writeLayout={writeLayout}
        onSelectPath={() => void window.electronAPI.dialog.openFile({ properties: ['openDirectory'] }).then(res => !res.canceled && res.filePaths[0] && setExportPath(res.filePaths[0]))}
        onWriteLayoutChange={setWriteLayout}
        onGlobalSettingsClick={() => setIsSettingsModalOpen(true)}
      />

      <div className="export-v2-body">
        <section className="export-v2-session-panel">
          <SessionTable
            sessions={displayedSessions}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selectedSessionIds={selectedSessionIds}
            onSelectionChange={setSelectedSessionIds}
            isLoading={isSessionsLoading || isContactsLoading}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortConfig={sortConfig}
            onSortChange={setSortConfig}
            error={sessionsError}
            metricsMap={metricsMap}
            loadingRefs={loadingRefs}
            metricsLoadingCount={loadingRefs.size}
            onRefreshStats={handleRefreshStats}
            isRefreshingStats={loadingRefs.size > 0}
            onSingleExport={handleSingleExport}
            onBatchExport={handleExportSelected}
            onAutomationExport={handleAutomationExportFromSelection}
          />
        </section>

        {(exportTasks.length > 0 || taskCenterBackgroundTasks.length > 0) && (
          <section className="export-v2-task-panel">
            <TaskCenter
              exportTasks={exportTasks}
              onCancelExportTask={cancelExportTask}
              onClearCompletedExportTasks={clearCompletedExportTasks}
              backgroundTasks={taskCenterBackgroundTasks}
              onPauseBackgroundTask={pauseBgTask}
              onResumeBackgroundTask={resumeBgTask}
              onCancelBackgroundTask={cancelBgTask}
              onClearCompletedBackgroundTasks={clearCompletedTaskCenterBackgroundTasks}
            />
          </section>
        )}
      </div>

      <ExportDialog
        dialogState={dialogState}
        onClose={closeDialog}
        options={options}
        exportPath={exportPath}
        onSelectPath={() => void window.electronAPI.dialog.openFile({ properties: ['openDirectory'] }).then(res => !res.canceled && res.filePaths[0] && setExportPath(res.filePaths[0]))}
        rawDateRangeConfig={rawDateRangeConfig}
        onConfirm={handleConfirmExport}
        onAutomationCreate={handleAutomationCreateFromDialog}
      />

      {isSettingsModalOpen && (
        <div 
          className="export-defaults-modal-overlay"
          onClick={() => setIsSettingsModalOpen(false)}
        >
          <div 
            className="export-defaults-modal"
            role="dialog"
            onClick={e => e.stopPropagation()}
          >
            <div className="export-defaults-modal-header">
              <h3>全局配置</h3>
              <button className="close-icon-btn" onClick={() => setIsSettingsModalOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="export-defaults-modal-body">
              <ExportDefaultsSettingsForm layout="split" onDefaultsChanged={handleExportDefaultsChanged} />
            </div>
            <div className="export-defaults-modal-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button 
                type="button" 
                className="secondary-btn"
                onClick={() => {
                  setIsSettingsModalOpen(false)
                  setIsAutomationModalOpen(true)
                }}
              >
                管理自动化任务
              </button>
              <button 
                type="button" 
                className="secondary-btn"
                onClick={() => setIsSettingsModalOpen(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {isAutomationModalOpen && (
        <AutomationModal
          onClose={() => setIsAutomationModalOpen(false)}
          onRunNow={enqueueAutomationTask}
        />
      )}

      {draftAutomationPayload && (
        <AutomationTaskForm
          basePayload={draftAutomationPayload}
          onSave={handleAutomationSave}
          onCancel={() => setDraftAutomationPayload(null)}
        />
      )}
    </div>
  )
}

export default memo(ExportPage)
