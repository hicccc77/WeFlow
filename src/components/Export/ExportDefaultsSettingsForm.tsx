import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import * as configService from '../../services/config'
import { ExportDateRangeDialog } from './ExportDateRangeDialog'
import {
  createDefaultExportDateRangeSelection,
  getExportDateRangeLabel,
  resolveExportDateRangeConfig,
  serializeExportDateRangeConfig,
  type ExportDateRangeSelection
} from '../../utils/exportDateRange'
import './ExportDefaultsSettingsForm.scss'

export interface ExportDefaultsSettingsPatch {
  format?: string
  avatars?: boolean
  dateRange?: ExportDateRangeSelection
  fileNamingMode?: configService.ExportFileNamingMode
  displayNamePreference?: configService.ExportDisplayNamePreference
  media?: configService.ExportDefaultMediaConfig
  voiceAsText?: boolean
  excelCompactColumns?: boolean
  concurrency?: number
}

interface ExportDefaultsSettingsFormProps {
  onNotify?: (text: string, success: boolean) => void
  onDefaultsChanged?: (patch: ExportDefaultsSettingsPatch) => void
  layout?: 'stacked' | 'split'
}

const exportFormatOptions = [
  { value: 'excel', label: 'Excel', desc: '电子表格，适合统计分析' },
  { value: 'json', label: 'JSON', desc: '详细格式，包含完整消息信息' },
  { value: 'html', label: 'HTML', desc: '网页格式，可直接浏览' },
  { value: 'markdown', label: 'Markdown', desc: '支持文本、图片与链接，适合 AI 场景' },
  { value: 'txt', label: 'TXT', desc: '纯文本，通用格式' },
  { value: 'arkme-json', label: 'Arkme JSON', desc: '紧凑 JSON，支持 sender 去重与关系统计' },
  { value: 'chatlab', label: 'ChatLab', desc: '标准格式，支持其他软件导入' },
  { value: 'chatlab-jsonl', label: 'ChatLab JSONL', desc: '流式格式，适合大量消息' },
  { value: 'weclone', label: 'WeClone CSV', desc: 'WeClone 兼容字段格式（CSV）' },
  { value: 'sql', label: 'PostgreSQL', desc: '数据库脚本，便于导入到数据库' }
] as const

const exportExcelColumnOptions = [
  { value: 'compact', label: '精简列', desc: '序号、时间、发送者身份、消息类型、内容' },
  { value: 'full', label: '完整列', desc: '含发送者昵称/微信ID/备注' }
] as const

const exportFileNamingModeOptions: Array<{ value: configService.ExportFileNamingMode; label: string; desc: string }> = [
  { value: 'classic', label: '简洁模式', desc: '示例：私聊_张三（兼容旧版）' },
  { value: 'date-range', label: '时间范围模式', desc: '示例：私聊_张三_20250101-20250331（推荐）' }
]

const exportDisplayNameOptions: Array<{ value: configService.ExportDisplayNamePreference; label: string; desc: string }> = [
  { value: 'group-nickname', label: '群昵称优先', desc: '群聊显示群昵称，缺失时回退备注/用户名' },
  { value: 'remark', label: '备注优先', desc: '有备注显示备注，否则显示用户名' },
  { value: 'nickname', label: '用户名优先', desc: '有用户名显示用户名，否则显示备注' }
]

const exportConcurrencyOptions = [1, 2, 3, 4, 5, 6] as const

const getOptionLabel = (options: ReadonlyArray<{ value: string; label: string }>, value: string) => {
  return options.find((option) => option.value === value)?.label ?? value
}

interface SelectDropdownPlacement {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
}

const resolveSelectDropdownPlacement = (anchor: HTMLElement | null): SelectDropdownPlacement | null => {
  if (!anchor || typeof window === 'undefined') return null

  const rect = anchor.getBoundingClientRect()
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  const viewportMargin = 12
  const dropdownGap = 6
  const minDropdownHeight = 128
  const availableWidth = Math.max(160, viewportWidth - viewportMargin * 2)
  const width = Math.min(Math.max(rect.width, 220), availableWidth)
  const left = Math.max(viewportMargin, Math.min(rect.left, viewportWidth - width - viewportMargin))
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - viewportMargin - dropdownGap)
  const spaceAbove = Math.max(0, rect.top - viewportMargin - dropdownGap)
  const shouldOpenAbove = spaceBelow < minDropdownHeight && spaceAbove > spaceBelow
  const availableHeight = shouldOpenAbove ? spaceAbove : spaceBelow
  const maxHeight = Math.max(96, Math.min(320, availableHeight))

  return shouldOpenAbove
    ? { left, width, maxHeight, bottom: viewportHeight - rect.top + dropdownGap }
    : { left, width, maxHeight, top: rect.bottom + dropdownGap }
}

const getSelectDropdownStyle = (placement: SelectDropdownPlacement): CSSProperties => ({
  position: 'fixed',
  top: placement.top,
  bottom: placement.bottom,
  left: placement.left,
  right: 'auto',
  width: placement.width,
  maxHeight: placement.maxHeight,
  zIndex: 9300
})

export function ExportDefaultsSettingsForm({
  onNotify,
  onDefaultsChanged,
  layout = 'stacked'
}: ExportDefaultsSettingsFormProps) {
  const [showExportExcelColumnsSelect, setShowExportExcelColumnsSelect] = useState(false)
  const [showExportFileNamingModeSelect, setShowExportFileNamingModeSelect] = useState(false)
  const [isExportDateRangeDialogOpen, setIsExportDateRangeDialogOpen] = useState(false)
  const exportExcelColumnsDropdownRef = useRef<HTMLDivElement>(null)
  const exportFileNamingModeDropdownRef = useRef<HTMLDivElement>(null)
  const exportExcelColumnsMenuRef = useRef<HTMLDivElement>(null)
  const exportFileNamingModeMenuRef = useRef<HTMLDivElement>(null)
  const [exportExcelColumnsPlacement, setExportExcelColumnsPlacement] = useState<SelectDropdownPlacement | null>(null)
  const [exportFileNamingModePlacement, setExportFileNamingModePlacement] = useState<SelectDropdownPlacement | null>(null)

  const [exportDefaultFormat, setExportDefaultFormat] = useState('excel')
  const [exportDefaultAvatars, setExportDefaultAvatars] = useState(true)
  const [exportDefaultDateRange, setExportDefaultDateRange] = useState<ExportDateRangeSelection>(() => createDefaultExportDateRangeSelection())
  const [exportDefaultFileNamingMode, setExportDefaultFileNamingMode] = useState<configService.ExportFileNamingMode>('classic')
  const [exportDefaultDisplayNamePreference, setExportDefaultDisplayNamePreference] = useState<configService.ExportDisplayNamePreference>('remark')
  const [exportDefaultMedia, setExportDefaultMedia] = useState<configService.ExportDefaultMediaConfig>({
    images: true,
    videos: true,
    voices: true,
    emojis: true,
    files: true,
    maxFileSizeMb: 200
  })
  const [exportDefaultVoiceAsText, setExportDefaultVoiceAsText] = useState(false)
  const [exportDefaultExcelCompactColumns, setExportDefaultExcelCompactColumns] = useState(true)
  const [exportDefaultConcurrency, setExportDefaultConcurrency] = useState(2)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [
        savedFormat,
        savedAvatars,
        savedDateRange,
        savedFileNamingMode,
        savedDisplayNamePreference,
        savedMedia,
        savedVoiceAsText,
        savedExcelCompactColumns,
        savedConcurrency
      ] = await Promise.all([
        configService.getExportDefaultFormat(),
        configService.getExportDefaultAvatars(),
        configService.getExportDefaultDateRange(),
        configService.getExportDefaultFileNamingMode(),
        configService.getExportDefaultDisplayNamePreference(),
        configService.getExportDefaultMedia(),
        configService.getExportDefaultVoiceAsText(),
        configService.getExportDefaultExcelCompactColumns(),
        configService.getExportDefaultConcurrency()
      ])

      if (cancelled) return

      setExportDefaultFormat(savedFormat || 'excel')
      setExportDefaultAvatars(savedAvatars ?? true)
      setExportDefaultDateRange(resolveExportDateRangeConfig(savedDateRange))
      setExportDefaultFileNamingMode(savedFileNamingMode ?? 'classic')
      setExportDefaultDisplayNamePreference(savedDisplayNamePreference ?? 'remark')
      setExportDefaultMedia(savedMedia ?? {
        images: true,
        videos: true,
        voices: true,
        emojis: true,
        files: true,
        maxFileSizeMb: 200
      })
      setExportDefaultVoiceAsText(savedVoiceAsText ?? false)
      setExportDefaultExcelCompactColumns(savedExcelCompactColumns ?? true)
      setExportDefaultConcurrency(savedConcurrency ?? 2)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        showExportExcelColumnsSelect &&
        exportExcelColumnsDropdownRef.current &&
        !exportExcelColumnsDropdownRef.current.contains(target) &&
        !exportExcelColumnsMenuRef.current?.contains(target)
      ) {
        setShowExportExcelColumnsSelect(false)
      }
      if (
        showExportFileNamingModeSelect &&
        exportFileNamingModeDropdownRef.current &&
        !exportFileNamingModeDropdownRef.current.contains(target) &&
        !exportFileNamingModeMenuRef.current?.contains(target)
      ) {
        setShowExportFileNamingModeSelect(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showExportExcelColumnsSelect, showExportFileNamingModeSelect])

  const updateSelectDropdownPlacements = useCallback(() => {
    if (showExportExcelColumnsSelect) {
      setExportExcelColumnsPlacement(resolveSelectDropdownPlacement(exportExcelColumnsDropdownRef.current))
    }
    if (showExportFileNamingModeSelect) {
      setExportFileNamingModePlacement(resolveSelectDropdownPlacement(exportFileNamingModeDropdownRef.current))
    }
  }, [showExportExcelColumnsSelect, showExportFileNamingModeSelect])

  useEffect(() => {
    if (!showExportExcelColumnsSelect) setExportExcelColumnsPlacement(null)
    if (!showExportFileNamingModeSelect) setExportFileNamingModePlacement(null)
    if (!showExportExcelColumnsSelect && !showExportFileNamingModeSelect) return

    updateSelectDropdownPlacements()
    window.addEventListener('resize', updateSelectDropdownPlacements)
    document.addEventListener('scroll', updateSelectDropdownPlacements, true)

    return () => {
      window.removeEventListener('resize', updateSelectDropdownPlacements)
      document.removeEventListener('scroll', updateSelectDropdownPlacements, true)
    }
  }, [showExportExcelColumnsSelect, showExportFileNamingModeSelect, updateSelectDropdownPlacements])

  const exportExcelColumnsValue = exportDefaultExcelCompactColumns ? 'compact' : 'full'
  const exportDateRangeLabel = useMemo(() => getExportDateRangeLabel(exportDefaultDateRange), [exportDefaultDateRange])
  const exportExcelColumnsLabel = useMemo(() => getOptionLabel(exportExcelColumnOptions, exportExcelColumnsValue), [exportExcelColumnsValue])
  const exportFileNamingModeLabel = useMemo(() => getOptionLabel(exportFileNamingModeOptions, exportDefaultFileNamingMode), [exportDefaultFileNamingMode])

  const notify = (text: string, success = true) => {
    onNotify?.(text, success)
  }

  const fileNamingModeDropdown = showExportFileNamingModeSelect && exportFileNamingModePlacement
    ? createPortal(
      <div
        ref={exportFileNamingModeMenuRef}
        className="select-dropdown select-dropdown-floating"
        role="listbox"
        style={getSelectDropdownStyle(exportFileNamingModePlacement)}
        onClick={(event) => event.stopPropagation()}
      >
        {exportFileNamingModeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={exportDefaultFileNamingMode === option.value}
            className={`select-option ${exportDefaultFileNamingMode === option.value ? 'active' : ''}`}
            onClick={async () => {
              setExportDefaultFileNamingMode(option.value)
              await configService.setExportDefaultFileNamingMode(option.value)
              onDefaultsChanged?.({ fileNamingMode: option.value })
              notify('已更新导出文件命名方式', true)
              setShowExportFileNamingModeSelect(false)
            }}
          >
            <span className="option-label">{option.label}</span>
            <span className="option-desc">{option.desc}</span>
          </button>
        ))}
      </div>,
      document.body
    )
    : null

  const excelColumnsDropdown = showExportExcelColumnsSelect && exportExcelColumnsPlacement
    ? createPortal(
      <div
        ref={exportExcelColumnsMenuRef}
        className="select-dropdown select-dropdown-floating"
        role="listbox"
        style={getSelectDropdownStyle(exportExcelColumnsPlacement)}
        onClick={(event) => event.stopPropagation()}
      >
        {exportExcelColumnOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={exportExcelColumnsValue === option.value}
            className={`select-option ${exportExcelColumnsValue === option.value ? 'active' : ''}`}
            onClick={async () => {
              const compact = option.value === 'compact'
              setExportDefaultExcelCompactColumns(compact)
              await configService.setExportDefaultExcelCompactColumns(compact)
              onDefaultsChanged?.({ excelCompactColumns: compact })
              notify(compact ? '已启用精简列' : '已启用完整列', true)
              setShowExportExcelColumnsSelect(false)
            }}
          >
            <span className="option-label">{option.label}</span>
            <span className="option-desc">{option.desc}</span>
          </button>
        ))}
      </div>,
      document.body
    )
    : null

  return (
    <div className={`export-defaults-settings-form ${layout === 'split' ? 'layout-split' : 'layout-stacked'}`}>
      <div className="form-group">
        <div className="form-copy">
          <label>导出并发数</label>
          <span className="form-hint">导出多个会话时的最大并发（1~6）</span>
        </div>
        <div className="form-control">
          <div className="concurrency-inline-options" role="radiogroup" aria-label="导出并发数">
            {exportConcurrencyOptions.map((option) => (
              <button
                key={option}
                type="button"
                className={`concurrency-option ${exportDefaultConcurrency === option ? 'active' : ''}`}
                aria-pressed={exportDefaultConcurrency === option}
                onClick={async () => {
                  setExportDefaultConcurrency(option)
                  await configService.setExportDefaultConcurrency(option)
                  onDefaultsChanged?.({ concurrency: option })
                  notify(`已将导出并发数设为 ${option}`, true)
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="form-group format-setting-group">
        <div className="form-copy">
          <label>聊天消息默认导出格式</label>
          <span className="form-hint">导出页面默认选中的格式</span>
        </div>
        <div className="form-control">
          <div className="format-grid">
            {exportFormatOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`format-card ${exportDefaultFormat === option.value ? 'active' : ''}`}
                onClick={async () => {
                  setExportDefaultFormat(option.value)
                  await configService.setExportDefaultFormat(option.value)
                  onDefaultsChanged?.({ format: option.value })
                  notify('已更新导出格式默认值', true)
                }}
              >
                <span className="format-label">{option.label}</span>
                <span className="format-desc">{option.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="form-group">
        <div className="form-copy">
          <label>聊天消息导出带头像</label>
          <span className="form-hint">开启后导出的聊天消息对应的文件中会带头像信息。</span>
        </div>
        <div className="form-control">
          <div className="log-toggle-line">
            <span className="log-status">{exportDefaultAvatars ? '已开启' : '已关闭'}</span>
            <label className="switch" htmlFor="shared-export-default-avatars">
              <input
                id="shared-export-default-avatars"
                className="switch-input"
                type="checkbox"
                checked={exportDefaultAvatars}
                onChange={async (e) => {
                  const enabled = e.target.checked
                  setExportDefaultAvatars(enabled)
                  await configService.setExportDefaultAvatars(enabled)
                  onDefaultsChanged?.({ avatars: enabled })
                  notify(enabled ? '已开启聊天消息导出带头像' : '已关闭聊天消息导出带头像', true)
                }}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>
      </div>

      <div className="form-group">
        <div className="form-copy">
          <label>默认导出时间范围</label>
          <span className="form-hint">控制导出页面的默认时间选择</span>
        </div>
        <div className="form-control">
          <div className="settings-time-range-field">
            <button
              type="button"
              className={`settings-time-range-trigger ${isExportDateRangeDialogOpen ? 'open' : ''}`}
              onClick={() => {
                setShowExportExcelColumnsSelect(false)
                setShowExportFileNamingModeSelect(false)
                setIsExportDateRangeDialogOpen(true)
              }}
            >
              <span className="settings-time-range-value">{exportDateRangeLabel}</span>
              <span className="settings-time-range-arrow">&gt;</span>
            </button>
          </div>
        </div>
      </div>

      <ExportDateRangeDialog
        open={isExportDateRangeDialogOpen}
        value={exportDefaultDateRange}
        onClose={() => setIsExportDateRangeDialogOpen(false)}
        onConfirm={async (nextSelection) => {
          setExportDefaultDateRange(nextSelection)
          await configService.setExportDefaultDateRange(serializeExportDateRangeConfig(nextSelection))
          onDefaultsChanged?.({ dateRange: nextSelection })
          notify('已更新默认导出时间范围', true)
          setIsExportDateRangeDialogOpen(false)
        }}
      />

      <div className="form-group">
        <div className="form-copy">
          <label>导出文件命名方式</label>
          <span className="form-hint">控制导出文件名是否包含时间范围</span>
        </div>
        <div className="form-control">
          <div className="select-field" ref={exportFileNamingModeDropdownRef}>
            <button
              type="button"
              className={`select-trigger ${showExportFileNamingModeSelect ? 'open' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={showExportFileNamingModeSelect}
              onClick={() => {
                setShowExportFileNamingModeSelect(!showExportFileNamingModeSelect)
                setShowExportExcelColumnsSelect(false)
                setIsExportDateRangeDialogOpen(false)
              }}
            >
              <span className="select-value">{exportFileNamingModeLabel}</span>
              <ChevronDown size={16} />
            </button>
            {fileNamingModeDropdown}
          </div>
        </div>
      </div>

      <div className="form-group display-name-setting-group">
        <div className="form-copy">
          <label>消息发送者命名方式</label>
          <span className="form-hint">控制群消息导出时发送者名称的优先级</span>
        </div>
        <div className="form-control">
          <div className="display-name-inline-options" role="radiogroup" aria-label="消息发送者命名方式">
            {exportDisplayNameOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`display-name-option ${exportDefaultDisplayNamePreference === option.value ? 'active' : ''}`}
                aria-pressed={exportDefaultDisplayNamePreference === option.value}
                title={option.desc}
                onClick={async () => {
                  setExportDefaultDisplayNamePreference(option.value)
                  await configService.setExportDefaultDisplayNamePreference(option.value)
                  onDefaultsChanged?.({ displayNamePreference: option.value })
                  notify('已更新消息发送者命名方式', true)
                }}
              >
                <span className="display-name-option-label">{option.label}</span>
                <span className="display-name-option-desc">{option.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="form-group">
        <div className="form-copy">
          <label>Excel 列显示</label>
          <span className="form-hint">控制 Excel 导出的列字段</span>
        </div>
        <div className="form-control">
          <div className="select-field" ref={exportExcelColumnsDropdownRef}>
            <button
              type="button"
              className={`select-trigger ${showExportExcelColumnsSelect ? 'open' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={showExportExcelColumnsSelect}
              onClick={() => {
                setShowExportExcelColumnsSelect(!showExportExcelColumnsSelect)
                setShowExportFileNamingModeSelect(false)
                setIsExportDateRangeDialogOpen(false)
              }}
            >
              <span className="select-value">{exportExcelColumnsLabel}</span>
              <ChevronDown size={16} />
            </button>
            {excelColumnsDropdown}
          </div>
        </div>
      </div>

      <div className="form-group media-setting-group">
        <div className="form-copy">
          <label>默认导出媒体内容</label>
          <span className="form-hint">控制图片、视频、语音、表情包、文件的默认导出开关</span>
        </div>
        <div className="form-control">
          <div className="media-default-grid">
            <label>
              <input
                type="checkbox"
                checked={exportDefaultMedia.images}
                onChange={async (e) => {
                  const next = { ...exportDefaultMedia, images: e.target.checked }
                  setExportDefaultMedia(next)
                  await configService.setExportDefaultMedia(next)
                  onDefaultsChanged?.({ media: next })
                  notify(`已${e.target.checked ? '开启' : '关闭'}默认导出图片`, true)
                }}
              />
              <span className="media-default-check" aria-hidden="true" />
              <span>图片</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={exportDefaultMedia.voices}
                onChange={async (e) => {
                  const next = { ...exportDefaultMedia, voices: e.target.checked }
                  setExportDefaultMedia(next)
                  await configService.setExportDefaultMedia(next)
                  onDefaultsChanged?.({ media: next })
                  notify(`已${e.target.checked ? '开启' : '关闭'}默认导出语音`, true)
                }}
              />
              <span className="media-default-check" aria-hidden="true" />
              <span>语音</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={exportDefaultMedia.videos}
                onChange={async (e) => {
                  const next = { ...exportDefaultMedia, videos: e.target.checked }
                  setExportDefaultMedia(next)
                  await configService.setExportDefaultMedia(next)
                  onDefaultsChanged?.({ media: next })
                  notify(`已${e.target.checked ? '开启' : '关闭'}默认导出视频`, true)
                }}
              />
              <span className="media-default-check" aria-hidden="true" />
              <span>视频</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={exportDefaultMedia.emojis}
                onChange={async (e) => {
                  const next = { ...exportDefaultMedia, emojis: e.target.checked }
                  setExportDefaultMedia(next)
                  await configService.setExportDefaultMedia(next)
                  onDefaultsChanged?.({ media: next })
                  notify(`已${e.target.checked ? '开启' : '关闭'}默认导出表情包`, true)
                }}
              />
              <span className="media-default-check" aria-hidden="true" />
              <span>表情包</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={exportDefaultMedia.files}
                onChange={async (e) => {
                  const next = { ...exportDefaultMedia, files: e.target.checked }
                  setExportDefaultMedia(next)
                  await configService.setExportDefaultMedia(next)
                  onDefaultsChanged?.({ media: next })
                  notify(`已${e.target.checked ? '开启' : '关闭'}默认导出文件`, true)
                }}
              />
              <span className="media-default-check" aria-hidden="true" />
              <span>文件</span>
            </label>
          </div>
          <div className="media-size-limit-control">
            <span>视频/文件最大体积</span>
            <input
              type="number"
              min={1}
              max={4096}
              value={exportDefaultMedia.maxFileSizeMb}
              onChange={async (e) => {
                const maxFileSizeMb = Math.max(1, Math.min(4096, Math.floor(Number(e.target.value) || 1)))
                const next = { ...exportDefaultMedia, maxFileSizeMb }
                setExportDefaultMedia(next)
                await configService.setExportDefaultMedia(next)
                onDefaultsChanged?.({ media: next })
                notify(`已将最大文件限制设为 ${maxFileSizeMb} MB`, true)
              }}
            />
            <span>MB</span>
          </div>
        </div>
      </div>

      <div className="form-group">
        <div className="form-copy">
          <label>默认语音转文字</label>
          <span className="form-hint">导出时默认将语音转写为文字</span>
        </div>
        <div className="form-control">
          <div className="log-toggle-line">
            <span className="log-status">{exportDefaultVoiceAsText ? '已开启' : '已关闭'}</span>
            <label className="switch" htmlFor="shared-export-default-voice-as-text">
              <input
                id="shared-export-default-voice-as-text"
                className="switch-input"
                type="checkbox"
                checked={exportDefaultVoiceAsText}
                onChange={async (e) => {
                  const enabled = e.target.checked
                  setExportDefaultVoiceAsText(enabled)
                  await configService.setExportDefaultVoiceAsText(enabled)
                  onDefaultsChanged?.({ voiceAsText: enabled })
                  notify(enabled ? '已开启默认语音转文字' : '已关闭默认语音转文字', true)
                }}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>
      </div>

    </div>
  )
}
