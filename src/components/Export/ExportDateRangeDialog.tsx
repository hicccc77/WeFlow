import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react'
import {
  EXPORT_DATE_RANGE_PRESETS,
  WEEKDAY_SHORT_LABELS,
  addMonths,
  buildCalendarCells,
  cloneExportDateRangeSelection,
  createDateRangeByPreset,
  createDefaultDateRange,
  formatCalendarMonthTitle,
  isSameDay,
  parseDateInputValue,
  startOfDay,
  endOfDay,
  toMonthStart,
  type ExportDateRangePreset,
  type ExportDateRangeSelection
} from '../../utils/exportDateRange'
import './ExportDateRangeDialog.scss'

interface ExportDateRangeDialogProps {
  open: boolean
  value: ExportDateRangeSelection
  title?: string
  minDate?: Date | null
  maxDate?: Date | null
  onClose: () => void
  onConfirm: (value: ExportDateRangeSelection) => void
}

type ActiveBoundary = 'start' | 'end'

interface ExportDateRangeDialogDraft extends ExportDateRangeSelection {
  panelMonth: Date
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) => `${index}`.padStart(2, '0'))
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => `${index}`.padStart(2, '0'))
const QUICK_TIME_OPTIONS = ['00:00', '08:00', '12:00', '18:00', '23:59']

const resolveBounds = (minDate?: Date | null, maxDate?: Date | null): { minDate: Date; maxDate: Date } | null => {
  if (!(minDate instanceof Date) || Number.isNaN(minDate.getTime())) return null
  if (!(maxDate instanceof Date) || Number.isNaN(maxDate.getTime())) return null
  const normalizedMin = startOfDay(minDate)
  const normalizedMax = endOfDay(maxDate)
  if (normalizedMin.getTime() > normalizedMax.getTime()) return null
  return {
    minDate: normalizedMin,
    maxDate: normalizedMax
  }
}

const clampSelectionToBounds = (
  value: ExportDateRangeSelection,
  minDate?: Date | null,
  maxDate?: Date | null
): ExportDateRangeSelection => {
  const bounds = resolveBounds(minDate, maxDate)
  if (!bounds) return cloneExportDateRangeSelection(value)

  // For custom selections, only ensure end >= start, preserve time precision
  if (value.preset === 'custom' && !value.useAllTime) {
    const { start, end } = value.dateRange
    if (end.getTime() < start.getTime()) {
      return {
        ...value,
        dateRange: { start, end: start }
      }
    }
    return cloneExportDateRangeSelection(value)
  }

  // For useAllTime, use bounds directly
  if (value.useAllTime) {
    return {
      preset: value.preset,
      useAllTime: true,
      dateRange: {
        start: bounds.minDate,
        end: bounds.maxDate
      }
    }
  }

  // For preset selections (not custom), clamp dates to bounds and use default times
  const nextStart = new Date(Math.min(Math.max(value.dateRange.start.getTime(), bounds.minDate.getTime()), bounds.maxDate.getTime()))
  const nextEndCandidate = new Date(Math.min(Math.max(value.dateRange.end.getTime(), bounds.minDate.getTime()), bounds.maxDate.getTime()))
  const nextEnd = nextEndCandidate.getTime() < nextStart.getTime() ? nextStart : nextEndCandidate

  // Set default times: start at 00:00:00, end at 23:59:59
  nextStart.setHours(0, 0, 0, 0)
  nextEnd.setHours(23, 59, 59, 999)

  return {
    preset: value.preset,
    useAllTime: false,
    dateRange: {
      start: nextStart,
      end: nextEnd
    }
  }
}

const buildDialogDraft = (
  value: ExportDateRangeSelection,
  minDate?: Date | null,
  maxDate?: Date | null
): ExportDateRangeDialogDraft => {
  const nextValue = clampSelectionToBounds(value, minDate, maxDate)
  return {
    ...nextValue,
    panelMonth: toMonthStart(nextValue.dateRange.start)
  }
}

export function ExportDateRangeDialog({
  open,
  value,
  title = '时间范围设置',
  minDate,
  maxDate,
  onClose,
  onConfirm
}: ExportDateRangeDialogProps) {
  // Helper: Format date only (YYYY-MM-DD) for the date input field
  const formatDateOnly = (date: Date): string => {
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  // Helper: Format time only (HH:mm) for the time input field
  const formatTimeOnly = (date: Date): string => {
    const h = `${date.getHours()}`.padStart(2, '0')
    const m = `${date.getMinutes()}`.padStart(2, '0')
    return `${h}:${m}`
  }

  const [draft, setDraft] = useState<ExportDateRangeDialogDraft>(() => buildDialogDraft(value, minDate, maxDate))
  const [activeBoundary, setActiveBoundary] = useState<ActiveBoundary>('start')
  const [dateInput, setDateInput] = useState({
    start: formatDateOnly(value.dateRange.start),
    end: formatDateOnly(value.dateRange.end)
  })
  const [dateInputError, setDateInputError] = useState({ start: false, end: false })

  // Default times: start at 00:00, end at 23:59
  const [timeInput, setTimeInput] = useState({
    start: '00:00',
    end: '23:59'
  })
  const [timeInputError, setTimeInputError] = useState({ start: false, end: false })
  const [openTimeDropdown, setOpenTimeDropdown] = useState<ActiveBoundary | null>(null)
  const startTimeSelectRef = useRef<HTMLDivElement>(null)
  const endTimeSelectRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const nextDraft = buildDialogDraft(value, minDate, maxDate)
    setDraft(nextDraft)
    setActiveBoundary('start')
    setDateInput({
      start: formatDateOnly(nextDraft.dateRange.start),
      end: formatDateOnly(nextDraft.dateRange.end)
    })
    // For preset-based selections (not custom), use default times 00:00 and 23:59
    // For custom selections, preserve the time from value.dateRange
    if (nextDraft.useAllTime || nextDraft.preset !== 'custom') {
      setTimeInput({
        start: '00:00',
        end: '23:59'
      })
    } else {
      setTimeInput({
        start: formatTimeOnly(nextDraft.dateRange.start),
        end: formatTimeOnly(nextDraft.dateRange.end)
      })
    }
    setOpenTimeDropdown(null)
    setDateInputError({ start: false, end: false })
  }, [maxDate, minDate, open, value])

  useEffect(() => {
    if (!open) return
    setDateInput({
      start: formatDateOnly(draft.dateRange.start),
      end: formatDateOnly(draft.dateRange.end)
    })
    // Don't sync timeInput here - it's controlled by the time picker
    setDateInputError({ start: false, end: false })
  }, [draft.dateRange.end.getTime(), draft.dateRange.start.getTime(), open])

  useEffect(() => {
    if (!openTimeDropdown) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      const activeContainer = openTimeDropdown === 'start'
        ? startTimeSelectRef.current
        : endTimeSelectRef.current
      if (!activeContainer?.contains(target)) {
        setOpenTimeDropdown(null)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenTimeDropdown(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [openTimeDropdown])

  const bounds = useMemo(() => resolveBounds(minDate, maxDate), [maxDate, minDate])
  const clampStartDate = useCallback((targetDate: Date) => {
    if (!bounds) return targetDate
    const min = bounds.minDate
    const max = bounds.maxDate
    if (targetDate.getTime() < min.getTime()) return min
    if (targetDate.getTime() > max.getTime()) return max
    return targetDate
  }, [bounds])
  const clampEndDate = useCallback((targetDate: Date) => {
    if (!bounds) return targetDate
    const min = bounds.minDate
    const max = bounds.maxDate
    if (targetDate.getTime() < min.getTime()) return min
    if (targetDate.getTime() > max.getTime()) return max
    return targetDate
  }, [bounds])

  const setRangeStart = useCallback((targetDate: Date) => {
    const start = clampStartDate(targetDate)
    setDraft(prev => {
      return {
        ...prev,
        preset: 'custom',
        useAllTime: false,
        dateRange: {
          start,
          end: prev.dateRange.end
        },
        panelMonth: toMonthStart(start)
      }
    })
  }, [clampStartDate])

  const setRangeEnd = useCallback((targetDate: Date) => {
    const end = clampEndDate(targetDate)
    setDraft(prev => {
      const nextStart = prev.useAllTime ? clampStartDate(targetDate) : prev.dateRange.start
      return {
        ...prev,
        preset: 'custom',
        useAllTime: false,
        dateRange: {
          start: nextStart,
          end: end
        },
        panelMonth: toMonthStart(targetDate)
      }
    })
  }, [clampEndDate, clampStartDate])

  const applyPreset = useCallback((preset: Exclude<ExportDateRangePreset, 'custom'>) => {
    if (preset === 'all') {
      const previewRange = bounds
        ? { start: bounds.minDate, end: bounds.maxDate }
        : createDefaultDateRange()
      setTimeInput({
        start: '00:00',
        end: '23:59'
      })
      setOpenTimeDropdown(null)
      setDraft(prev => ({
        ...prev,
        preset,
        useAllTime: true,
        dateRange: previewRange,
        panelMonth: toMonthStart(previewRange.start)
      }))
      setActiveBoundary('start')
      return
    }

    const range = clampSelectionToBounds({
      preset,
      useAllTime: false,
      dateRange: createDateRangeByPreset(preset)
    }, minDate, maxDate).dateRange
    setTimeInput({
      start: '00:00',
      end: '23:59'
    })
    setOpenTimeDropdown(null)
    setDraft(prev => ({
      ...prev,
      preset,
      useAllTime: false,
      dateRange: range,
      panelMonth: toMonthStart(range.start)
    }))
    setActiveBoundary('start')
  }, [bounds, maxDate, minDate])

  const parseTimeValue = (timeStr: string): { hours: number; minutes: number } | null => {
    const matched = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim())
    if (!matched) return null
    const hours = Number(matched[1])
    const minutes = Number(matched[2])
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
    return { hours, minutes }
  }

  const updateBoundaryTime = useCallback((boundary: ActiveBoundary, timeStr: string) => {
    setTimeInput(prev => ({ ...prev, [boundary]: timeStr }))

    const parsedTime = parseTimeValue(timeStr)
    if (!parsedTime) {
      setTimeInputError(prev => ({ ...prev, [boundary]: true }))
      return
    }
    setTimeInputError(prev => ({ ...prev, [boundary]: false }))

    setDraft(prev => {
      const dateObj = boundary === 'start' ? prev.dateRange.start : prev.dateRange.end
      const newDate = new Date(dateObj)
      newDate.setHours(parsedTime.hours, parsedTime.minutes, 0, 0)
      return {
        ...prev,
        preset: 'custom',
        useAllTime: false,
        dateRange: {
          ...prev.dateRange,
          [boundary]: newDate
        }
      }
    })
  }, [])

  const handleTimeInputFocus = useCallback((boundary: ActiveBoundary) => {
    setActiveBoundary(boundary)
    setOpenTimeDropdown(boundary)
  }, [])

  const handleTimeColumnSelect = useCallback((boundary: ActiveBoundary, field: 'hour' | 'minute', value: string) => {
    const parsedCurrent = parseTimeValue(timeInput[boundary]) ?? {
      hours: boundary === 'start' ? 0 : 23,
      minutes: boundary === 'start' ? 0 : 59
    }
    const nextHours = field === 'hour' ? Number(value) : parsedCurrent.hours
    const nextMinutes = field === 'minute' ? Number(value) : parsedCurrent.minutes
    updateBoundaryTime(boundary, `${`${nextHours}`.padStart(2, '0')}:${`${nextMinutes}`.padStart(2, '0')}`)
  }, [timeInput, updateBoundaryTime])

  const renderTimeDropdown = (boundary: ActiveBoundary) => {
    const currentTime = timeInput[boundary]
    const parsedCurrent = parseTimeValue(currentTime) ?? {
      hours: boundary === 'start' ? 0 : 23,
      minutes: boundary === 'start' ? 0 : 59
    }

    return (
      <div className="export-date-range-time-dropdown" onClick={(event) => event.stopPropagation()}>
        <div className="export-date-range-time-dropdown-header">
          <span>{boundary === 'start' ? '开始时间' : '结束时间'}</span>
          <strong>{currentTime}</strong>
        </div>
        <div className="export-date-range-time-quick-list">
          {QUICK_TIME_OPTIONS.map(option => (
            <button
              key={`${boundary}-${option}`}
              type="button"
              className={`export-date-range-time-quick-item ${currentTime === option ? 'active' : ''}`}
              onClick={() => updateBoundaryTime(boundary, option)}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="export-date-range-time-columns">
          <div className="export-date-range-time-column">
            <span className="export-date-range-time-column-label">小时</span>
            <div className="export-date-range-time-column-list">
              {HOUR_OPTIONS.map(option => (
                <button
                  key={`${boundary}-hour-${option}`}
                  type="button"
                  className={`export-date-range-time-option ${parsedCurrent.hours === Number(option) ? 'active' : ''}`}
                  onClick={() => handleTimeColumnSelect(boundary, 'hour', option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="export-date-range-time-column">
            <span className="export-date-range-time-column-label">分钟</span>
            <div className="export-date-range-time-column-list">
              {MINUTE_OPTIONS.map(option => (
                <button
                  key={`${boundary}-minute-${option}`}
                  type="button"
                  className={`export-date-range-time-option ${parsedCurrent.minutes === Number(option) ? 'active' : ''}`}
                  onClick={() => handleTimeColumnSelect(boundary, 'minute', option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Check if date input string contains time (YYYY-MM-DD HH:mm format)
  const dateInputHasTime = (dateStr: string): boolean => /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(dateStr.trim())

  const commitStartFromInput = useCallback(() => {
    const parsedDate = parseDateInputValue(dateInput.start)
    if (!parsedDate) {
      setDateInputError(prev => ({ ...prev, start: true }))
      return
    }
    // Only apply time picker value if date input doesn't contain time
    if (!dateInputHasTime(dateInput.start)) {
      const parsedTime = parseTimeValue(timeInput.start)
      if (parsedTime) {
        parsedDate.setHours(parsedTime.hours, parsedTime.minutes, 0, 0)
      }
    }
    setDateInputError(prev => ({ ...prev, start: false }))
    setRangeStart(parsedDate)
  }, [dateInput.start, timeInput.start, setRangeStart])

  const commitEndFromInput = useCallback(() => {
    const parsedDate = parseDateInputValue(dateInput.end)
    if (!parsedDate) {
      setDateInputError(prev => ({ ...prev, end: true }))
      return
    }
    // Only apply time picker value if date input doesn't contain time
    if (!dateInputHasTime(dateInput.end)) {
      const parsedTime = parseTimeValue(timeInput.end)
      if (parsedTime) {
        parsedDate.setHours(parsedTime.hours, parsedTime.minutes, 0, 0)
      }
    }
    setDateInputError(prev => ({ ...prev, end: false }))
    setRangeEnd(parsedDate)
  }, [dateInput.end, timeInput.end, setRangeEnd])

  const shiftPanelMonth = useCallback((delta: number) => {
    setDraft(prev => ({
      ...prev,
      panelMonth: addMonths(prev.panelMonth, delta)
    }))
  }, [])

  const handleCalendarSelect = useCallback((targetDate: Date) => {
    // Use time from timeInput state (which is updated by the time picker)
    const parseTime = (timeStr: string): { hours: number; minutes: number } => {
      const matched = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim())
      if (!matched) return { hours: 0, minutes: 0 }
      return { hours: Number(matched[1]), minutes: Number(matched[2]) }
    }

    if (activeBoundary === 'start') {
      const newStart = new Date(targetDate)
      const time = parseTime(timeInput.start)
      newStart.setHours(time.hours, time.minutes, 0, 0)
      setRangeStart(newStart)
      setActiveBoundary('end')
      setOpenTimeDropdown(null)
      return
    }

    const pickedStart = startOfDay(targetDate)
    const start = draft.useAllTime ? startOfDay(targetDate) : draft.dateRange.start
    const nextStart = pickedStart <= start ? pickedStart : start

    const newEnd = new Date(targetDate)
    const time = parseTime(timeInput.end)
    // If selecting same day or going backwards, use 23:59:59, otherwise use the time from timeInput
    if (pickedStart <= start) {
      newEnd.setHours(23, 59, 59, 999)
      setTimeInput(prev => ({ ...prev, end: '23:59' }))
    } else {
      newEnd.setHours(time.hours, time.minutes, 59, 999)
    }

    setDraft(prev => ({
      ...prev,
      preset: 'custom',
      useAllTime: false,
      dateRange: {
        start: nextStart,
        end: newEnd
      },
      panelMonth: toMonthStart(targetDate)
    }))
    setActiveBoundary('start')
    setOpenTimeDropdown(null)
  }, [activeBoundary, draft.dateRange.start, draft.useAllTime, timeInput.end, timeInput.start, setRangeStart])

  const isRangeModeActive = !draft.useAllTime
  const modeText = isRangeModeActive
    ? '当前导出模式：按时间范围导出'
    : '当前导出模式：全部时间导出，选择下方日期会切换为自定义时间范围'

  const isPresetActive = useCallback((preset: ExportDateRangePreset): boolean => {
    if (preset === 'all') return draft.useAllTime
    return !draft.useAllTime && draft.preset === preset
  }, [draft])

  const calendarCells = useMemo(() => buildCalendarCells(draft.panelMonth), [draft.panelMonth])
  const minPanelMonth = bounds ? toMonthStart(bounds.minDate) : null
  const maxPanelMonth = bounds ? toMonthStart(bounds.maxDate) : null
  const canShiftPrev = !minPanelMonth || draft.panelMonth.getTime() > minPanelMonth.getTime()
  const canShiftNext = !maxPanelMonth || draft.panelMonth.getTime() < maxPanelMonth.getTime()

  const isStartSelected = useCallback((date: Date) => (
    !draft.useAllTime && isSameDay(date, draft.dateRange.start)
  ), [draft])

  const isEndSelected = useCallback((date: Date) => (
    !draft.useAllTime && isSameDay(date, draft.dateRange.end)
  ), [draft])

  const isDateInRange = useCallback((date: Date) => (
    !draft.useAllTime &&
    startOfDay(date).getTime() >= startOfDay(draft.dateRange.start).getTime() &&
    startOfDay(date).getTime() <= startOfDay(draft.dateRange.end).getTime()
  ), [draft])

  const isDateSelectable = useCallback((date: Date) => {
    if (!bounds) return true
    const target = startOfDay(date).getTime()
    return target >= startOfDay(bounds.minDate).getTime() && target <= startOfDay(bounds.maxDate).getTime()
  }, [bounds])

  const hintText = draft.useAllTime
    ? '选择开始或结束日期后，会自动切换为自定义时间范围'
    : (activeBoundary === 'start' ? '下一次点击将设置开始日期' : '下一次点击将设置结束日期')

  if (!open) return null

  return createPortal(
    <div className="export-date-range-dialog-overlay" onClick={onClose}>
      <div className="export-date-range-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="export-date-range-dialog-header">
          <h4>{title}</h4>
          <button
            type="button"
            className="export-date-range-dialog-close-btn"
            onClick={onClose}
            aria-label="关闭时间范围设置"
          >
            <X size={14} />
          </button>
        </div>

        <div className="export-date-range-preset-list">
          {EXPORT_DATE_RANGE_PRESETS.map((preset) => {
            const active = isPresetActive(preset.value)
            return (
              <button
                key={preset.value}
                type="button"
                className={`export-date-range-preset-item ${active ? 'active' : ''}`}
                onClick={() => applyPreset(preset.value)}
              >
                <span>{preset.label}</span>
                {active && <Check size={14} />}
              </button>
            )
          })}
        </div>

        <div className={`export-date-range-mode-banner ${isRangeModeActive ? 'range' : 'all'}`}>
          {modeText}
        </div>

        <div className="export-date-range-boundary-row">
          <div
            className={`export-date-range-boundary-card ${activeBoundary === 'start' ? 'active' : ''}`}
            onClick={() => setActiveBoundary('start')}
          >
            <span className="boundary-label">开始</span>
            <input
              type="text"
              className={`export-date-range-date-input ${dateInputError.start ? 'invalid' : ''}`}
              value={dateInput.start}
              placeholder="YYYY-MM-DD"
              onChange={(event) => {
                const nextValue = event.target.value
                setDateInput(prev => ({ ...prev, start: nextValue }))
                if (dateInputError.start) {
                  setDateInputError(prev => ({ ...prev, start: false }))
                }
              }}
              onFocus={() => setActiveBoundary('start')}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                commitStartFromInput()
              }}
              onBlur={commitStartFromInput}
            />
            <div
              className={`export-date-range-time-select ${openTimeDropdown === 'start' ? 'open' : ''}`}
              ref={startTimeSelectRef}
              onClick={(event) => event.stopPropagation()}
            >
              <input
                type="text"
                className={`export-date-range-date-input ${timeInputError.start ? 'invalid' : ''}`}
                value={timeInput.start}
                placeholder="HH:mm"
                onChange={(event) => {
                  const nextValue = event.target.value
                  updateBoundaryTime('start', nextValue)
                }}
                onFocus={() => {
                  setActiveBoundary('start')
                  setOpenTimeDropdown('start')
                }}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  setOpenTimeDropdown(null)
                }}
              />
              {openTimeDropdown === 'start' && renderTimeDropdown('start')}
            </div>
          </div>
          <div
            className={`export-date-range-boundary-card ${activeBoundary === 'end' ? 'active' : ''}`}
            onClick={() => setActiveBoundary('end')}
          >
            <span className="boundary-label">结束</span>
            <input
              type="text"
              className={`export-date-range-date-input ${dateInputError.end ? 'invalid' : ''}`}
              value={dateInput.end}
              placeholder="YYYY-MM-DD"
              onChange={(event) => {
                const nextValue = event.target.value
                setDateInput(prev => ({ ...prev, end: nextValue }))
                if (dateInputError.end) {
                  setDateInputError(prev => ({ ...prev, end: false }))
                }
              }}
              onFocus={() => setActiveBoundary('end')}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                commitEndFromInput()
              }}
              onBlur={commitEndFromInput}
            />
            <div
              className={`export-date-range-time-select ${openTimeDropdown === 'end' ? 'open' : ''}`}
              ref={endTimeSelectRef}
              onClick={(event) => event.stopPropagation()}
            >
              <input
                type="text"
                className={`export-date-range-date-input ${timeInputError.end ? 'invalid' : ''}`}
                value={timeInput.end}
                placeholder="HH:mm"
                onChange={(event) => {
                  const nextValue = event.target.value
                  updateBoundaryTime('end', nextValue)
                }}
                onFocus={() => {
                  setActiveBoundary('end')
                  setOpenTimeDropdown('end')
                }}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  setOpenTimeDropdown(null)
                }}
              />
              {openTimeDropdown === 'end' && renderTimeDropdown('end')}
            </div>
          </div>
        </div>

        <div className="export-date-range-selection-hint">{hintText}</div>

        <section className="export-date-range-calendar-panel single">
          <div className="export-date-range-calendar-panel-header">
            <div className="export-date-range-calendar-date-label">
              <span>选择日期范围</span>
              <strong>{formatCalendarMonthTitle(draft.panelMonth)}</strong>
            </div>
            <div className="export-date-range-calendar-nav">
              <button type="button" onClick={() => shiftPanelMonth(-1)} aria-label="上个月" disabled={!canShiftPrev}>
                <ChevronLeft size={14} />
              </button>
              <button type="button" onClick={() => shiftPanelMonth(1)} aria-label="下个月" disabled={!canShiftNext}>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <div className="export-date-range-calendar-weekdays">
            {WEEKDAY_SHORT_LABELS.map(label => (
              <span key={`weekday-${label}`}>{label}</span>
            ))}
          </div>
          <div className="export-date-range-calendar-days">
            {calendarCells.map((cell) => {
              const startSelected = isStartSelected(cell.date)
              const endSelected = isEndSelected(cell.date)
              const inRange = isDateInRange(cell.date)
              const selectable = isDateSelectable(cell.date)
              return (
                <button
                  key={cell.date.getTime()}
                  type="button"
                  disabled={!selectable}
                  className={[
                    'export-date-range-calendar-day',
                    cell.inCurrentMonth ? '' : 'outside',
                    selectable ? '' : 'disabled',
                    inRange ? 'in-range' : '',
                    startSelected ? 'range-start' : '',
                    endSelected ? 'range-end' : '',
                    activeBoundary === 'start' && startSelected ? 'active-boundary' : '',
                    activeBoundary === 'end' && endSelected ? 'active-boundary' : ''
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleCalendarSelect(cell.date)}
                >
                  {cell.date.getDate()}
                </button>
              )
            })}
          </div>
        </section>

        <div className="export-date-range-dialog-actions">
          <button type="button" className="export-date-range-dialog-btn secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="export-date-range-dialog-btn primary"
            onClick={() => {
              // Validate: end time should not be earlier than start time
              if (draft.dateRange.end.getTime() < draft.dateRange.start.getTime()) {
                setDateInputError({ start: true, end: true })
                return
              }
              onConfirm(cloneExportDateRangeSelection(draft))
            }}
          >
            确认
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
