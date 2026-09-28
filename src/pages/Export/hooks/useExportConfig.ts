/**
 * ExportV2 — useExportConfig hook
 *
 * Manages global export configurations: output path, write layout, and export options.
 * Synchronizes state with configService for persistence.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { ExportOptions, TextExportFormat, DisplayNamePreference } from '../types'
import { createDefaultExportOptions, defaultTxtColumns } from '../constants'
import type { ExportWriteLayout } from '../../../services/config'
import * as configService from '../../../services/config'
import {
  resolveExportDateRangeConfig,
  type ExportDefaultDateRangeConfig
} from '../../../utils/exportDateRange'

export interface ExportConfigResult {
  isLoaded: boolean
  
  // Base settings
  exportPath: string
  setExportPath: (path: string) => void
  
  writeLayout: ExportWriteLayout
  setWriteLayout: (layout: ExportWriteLayout) => void

  // Export options
  options: ExportOptions
  updateOptions: (patch: Partial<ExportOptions>) => void
  
  // Full raw date range config (for the date range picker)
  rawDateRangeConfig: ExportDefaultDateRangeConfig | string | null
  setRawDateRangeConfig: (config: ExportDefaultDateRangeConfig | string | null) => void
}

export function useExportConfig(): ExportConfigResult {
  const [isLoaded, setIsLoaded] = useState(false)
  const [exportPath, setExportPathState] = useState<string>('')
  const [writeLayout, setWriteLayoutState] = useState<ExportWriteLayout>('C')
  const [options, setOptions] = useState<ExportOptions>(createDefaultExportOptions())
  const [rawDateRangeConfig, setRawDateRangeConfigState] = useState<ExportDefaultDateRangeConfig | string | null>(null)

  // Use a ref to avoid infinite loops if we need to check current state in effects
  const optionsRef = useRef(options)
  optionsRef.current = options

  // 1. Initial Load
  useEffect(() => {
    let isMounted = true
    
    const loadConfigs = async () => {
      try {
        const [
          path,
          layout,
          format,
          avatars,
          media,
          dateRange,
          voiceAsText,
          pathStyle,
          excelCompact,
          txtCols,
          concurrency,
          fileNamingMode,
          displayNamePreference
        ] = await Promise.all([
          configService.getExportPath(),
          configService.getExportWriteLayout(),
          configService.getExportDefaultFormat(),
          configService.getExportDefaultAvatars(),
          configService.getExportDefaultMedia(),
          configService.getExportDefaultDateRange(),
          configService.getExportDefaultVoiceAsText(),
          configService.getExportDefaultPathStyle(),
          configService.getExportDefaultExcelCompactColumns(),
          configService.getExportDefaultTxtColumns(),
          configService.getExportDefaultConcurrency(),
          configService.getExportDefaultFileNamingMode(),
          configService.getExportDefaultDisplayNamePreference()
        ])

        if (!isMounted) return

        // Base settings
        if (path) {
          setExportPathState(path)
        } else {
          try {
            const downloadsPath = await window.electronAPI.app.getDownloadsPath()
            setExportPathState(downloadsPath)
          } catch (e) {
            setExportPathState('')
          }
        }
        setWriteLayoutState(layout || 'C')
        
        // Build ExportOptions from multiple configs
        const newOptions = createDefaultExportOptions()
        
        if (format) newOptions.format = format as TextExportFormat
        if (typeof avatars === 'boolean') newOptions.exportAvatars = avatars
        if (media) {
          newOptions.exportImages = media.images !== false
          newOptions.exportVideos = media.videos !== false
          newOptions.exportVoices = media.voices !== false
          newOptions.exportEmojis = media.emojis !== false
          newOptions.exportFiles = media.files !== false
          if (typeof media.maxFileSizeMb === 'number' && media.maxFileSizeMb > 0) {
            newOptions.maxFileSizeMb = media.maxFileSizeMb
          }
          // The old page had `exportMedia: true` derived from whether any media was checked
          newOptions.exportMedia = (
            newOptions.exportImages || 
            newOptions.exportVideos || 
            newOptions.exportVoices || 
            newOptions.exportEmojis || 
            newOptions.exportFiles
          )
        }
        
        if (typeof voiceAsText === 'boolean') newOptions.exportVoiceAsText = voiceAsText
        if (pathStyle === 'auto' || pathStyle === 'posix' || pathStyle === 'windows') newOptions.exportPathStyle = pathStyle
        if (typeof excelCompact === 'boolean') newOptions.excelCompactColumns = excelCompact
        if (Array.isArray(txtCols)) newOptions.txtColumns = txtCols
        if (typeof concurrency === 'number' && concurrency > 0) newOptions.exportConcurrency = concurrency
        if (fileNamingMode === 'classic' || fileNamingMode === 'date-range') newOptions.fileNamingMode = fileNamingMode
        if (displayNamePreference === 'group-nickname' || displayNamePreference === 'remark' || displayNamePreference === 'nickname') {
          newOptions.displayNamePreference = displayNamePreference
        }

        // Date range
        setRawDateRangeConfigState(dateRange)
        if (dateRange) {
          const resolvedDateRange = resolveExportDateRangeConfig(dateRange as any, new Date())
          newOptions.useAllTime = resolvedDateRange.useAllTime
          newOptions.dateRange = resolvedDateRange.dateRange
        }

        setOptions(newOptions)
      } catch (err) {
        console.error('[useExportConfig] Error loading configs:', err)
      } finally {
        if (isMounted) setIsLoaded(true)
      }
    }

    void loadConfigs()
    return () => { isMounted = false }
  }, [])

  // 2. Setters (State + ConfigService)
  const setExportPath = useCallback((path: string) => {
    setExportPathState(path)
    void configService.setExportPath(path)
  }, [])

  const setWriteLayout = useCallback((layout: ExportWriteLayout) => {
    setWriteLayoutState(layout)
    void configService.setExportWriteLayout(layout)
  }, [])

  const updateOptions = useCallback((patch: Partial<ExportOptions>) => {
    setOptions(prev => {
      const next = { ...prev, ...patch }
      
      // Persist individual keys based on the patch
      if (patch.format !== undefined) {
        void configService.setExportDefaultFormat(patch.format)
      }
      if (patch.exportAvatars !== undefined) {
        void configService.setExportDefaultAvatars(patch.exportAvatars)
      }
      if (
        patch.exportImages !== undefined ||
        patch.exportVideos !== undefined ||
        patch.exportVoices !== undefined ||
        patch.exportEmojis !== undefined ||
        patch.exportFiles !== undefined ||
        patch.maxFileSizeMb !== undefined
      ) {
        void configService.setExportDefaultMedia({
          images: next.exportImages,
          videos: next.exportVideos,
          voices: next.exportVoices,
          emojis: next.exportEmojis,
          files: next.exportFiles,
          maxFileSizeMb: next.maxFileSizeMb
        })
      }
      if (patch.exportVoiceAsText !== undefined) {
        void configService.setExportDefaultVoiceAsText(patch.exportVoiceAsText)
      }
      if (patch.exportPathStyle !== undefined) {
        void configService.setExportDefaultPathStyle(patch.exportPathStyle)
      }
      if (patch.excelCompactColumns !== undefined) {
        void configService.setExportDefaultExcelCompactColumns(patch.excelCompactColumns)
      }
      if (patch.txtColumns !== undefined) {
        void configService.setExportDefaultTxtColumns(patch.txtColumns)
      }
      if (patch.exportConcurrency !== undefined) {
        void configService.setExportDefaultConcurrency(patch.exportConcurrency)
      }
      if (patch.fileNamingMode !== undefined) {
        void configService.setExportDefaultFileNamingMode(patch.fileNamingMode)
      }
      if (patch.displayNamePreference !== undefined) {
        void configService.setExportDefaultDisplayNamePreference(patch.displayNamePreference)
      }
      
      // Auto-derive exportMedia
      next.exportMedia = (
        next.exportImages || 
        next.exportVideos || 
        next.exportVoices || 
        next.exportEmojis || 
        next.exportFiles
      )
      
      return next
    })
  }, [])

  const setRawDateRangeConfig = useCallback((config: ExportDefaultDateRangeConfig | string | null) => {
    setRawDateRangeConfigState(config)
    if (config) {
      void configService.setExportDefaultDateRange(config as any)
      
      // Update options as well
      const resolvedDateRange = resolveExportDateRangeConfig(config as any, new Date())
      updateOptions({
        useAllTime: resolvedDateRange.useAllTime,
        dateRange: resolvedDateRange.dateRange
      })
    }
  }, [updateOptions])

  return {
    isLoaded,
    exportPath,
    setExportPath,
    writeLayout,
    setWriteLayout,
    options,
    updateOptions,
    rawDateRangeConfig,
    setRawDateRangeConfig
  }
}
