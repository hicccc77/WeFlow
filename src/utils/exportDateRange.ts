export type ExportDateRangePreset =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'last3days'
  | 'last7days'
  | 'last30days'
  | 'last1year'
  | 'last2years'
  | 'custom'

export type CalendarCell = { date: Date; inCurrentMonth: boolean }

export interface ExportDateRange {
  start: Date
  end: Date
}

export interface ExportDateRangeSelection {
  preset: ExportDateRangePreset
  useAllTime: boolean
  dateRange: ExportDateRange
}

export interface ExportDefaultDateRangeConfig {
  version?: 1
  preset?: ExportDateRangePreset | string
  useAllTime?: boolean
  start?: string | number | Date | null
  end?: string | number | Date | null
}

export const EXPORT_DATE_RANGE_PRESETS: Array<{
  value: Exclude<ExportDateRangePreset, 'custom'>
  label: string
}> = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: 'last3days', label: '最近3天' },
  { value: 'last7days', label: '最近一周' },
  { value: 'last30days', label: '最近30天' },
  { value: 'last1year', label: '最近一年' }
]

const PRESET_LABELS: Record<Exclude<ExportDateRangePreset, 'custom'>, string> = {
  all: '全部时间',
  today: '今天',
  yesterday: '昨天',
  last3days: '最近3天',
  last7days: '最近一周',
  last30days: '最近30天',
  last1year: '最近一年',
  last2years: '最近两年'
}

const LEGACY_PRESET_MAP: Record<string, Exclude<ExportDateRangePreset, 'custom'> | 'legacy90days'> = {
  all: 'all',
  today: 'today',
  yesterday: 'yesterday',
  last3days: 'last3days',
  last7days: 'last7days',
  last30days: 'last30days',
  last1year: 'last1year',
  last2years: 'last2years',
  '7d': 'last7days',
  '30d': 'last30days',
  '90d': 'legacy90days'
}

export const WEEKDAY_SHORT_LABELS = ['日', '一', '二', '三', '四', '五', '六']

export const startOfDay = (date: Date): Date => {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

export const endOfDay = (date: Date): Date => {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next
}

export const createDefaultDateRange = (): ExportDateRange => {
  const now = new Date()
  return {
    start: startOfDay(now),
    end: now
  }
}

export const createDateRangeByPreset = (
  preset: Exclude<ExportDateRangePreset, 'all' | 'custom'>,
  now = new Date()
): ExportDateRange => {
  const end = new Date(now)
  const baseStart = startOfDay(now)

  if (preset === 'today') {
    return { start: baseStart, end }
  }

  if (preset === 'yesterday') {
    const yesterday = new Date(baseStart)
    yesterday.setDate(yesterday.getDate() - 1)
    return {
      start: yesterday,
      end: endOfDay(yesterday)
    }
  }

  if (preset === 'last1year' || preset === 'last2years') {
    const yearsBack = preset === 'last1year' ? 1 : 2
    const start = new Date(baseStart)
    const expectedMonth = start.getMonth()
    start.setFullYear(start.getFullYear() - yearsBack)
    if (start.getMonth() !== expectedMonth) {
      start.setDate(0)
    }
    return { start, end }
  }

  const daysBack = preset === 'last3days' ? 2 : preset === 'last7days' ? 6 : 29
  const start = new Date(baseStart)
  start.setDate(start.getDate() - daysBack)
  return { start, end }
}

export const createDateRangeByLastNDays = (days: number, now = new Date()): ExportDateRange => {
  const end = new Date(now)
  const start = startOfDay(now)
  start.setDate(start.getDate() - Math.max(0, days - 1))
  return { start, end }
}

export const formatDateInputValue = (date: Date): string => {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  const h = `${date.getHours()}`.padStart(2, '0')
  const min = `${date.getMinutes()}`.padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

export const parseDateInputValue = (raw: string): Date | null => {
  const text = String(raw || '').trim()
  const matched = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(text)
  if (!matched) return null
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const hour = matched[4] !== undefined ? Number(matched[4]) : 0
  const minute = matched[5] !== undefined ? Number(matched[5]) : 0
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null
  }
  return parsed
}

export const toMonthStart = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), 1)

export const addMonths = (date: Date, delta: number): Date => {
  const next = new Date(date)
  next.setMonth(next.getMonth() + delta)
  return toMonthStart(next)
}

export const isSameDay = (left: Date, right: Date): boolean => (
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate()
)

export const buildCalendarCells = (monthStart: Date): CalendarCell[] => {
  const firstDay = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1)
  const startOffset = firstDay.getDay()
  const gridStart = new Date(firstDay)
  gridStart.setDate(gridStart.getDate() - startOffset)
  const cells: CalendarCell[] = []
  for (let index = 0; index < 42; index += 1) {
    const current = new Date(gridStart)
    current.setDate(gridStart.getDate() + index)
    cells.push({
      date: current,
      inCurrentMonth: current.getMonth() === monthStart.getMonth()
    })
  }
  return cells
}

export const formatCalendarMonthTitle = (date: Date): string => `${date.getFullYear()}年${date.getMonth() + 1}月`

export const cloneExportDateRange = (range: ExportDateRange): ExportDateRange => ({
  start: new Date(range.start),
  end: new Date(range.end)
})

export const cloneExportDateRangeSelection = (selection: ExportDateRangeSelection): ExportDateRangeSelection => ({
  preset: selection.preset,
  useAllTime: selection.useAllTime,
  dateRange: cloneExportDateRange(selection.dateRange)
})

export const createExportDateRangeSelectionFromPreset = (
  preset: Exclude<ExportDateRangePreset, 'custom'>,
  now = new Date()
): ExportDateRangeSelection => {
  if (preset === 'all') {
    return {
      preset,
      useAllTime: true,
      dateRange: createDefaultDateRange()
    }
  }

  return {
    preset,
    useAllTime: false,
    dateRange: createDateRangeByPreset(preset, now)
  }
}

export const createDefaultExportDateRangeSelection = (): ExportDateRangeSelection => (
  createExportDateRangeSelectionFromPreset('today')
)

const parseStoredDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof value === 'string') {
    const normalized = parseDateInputValue(value)
    if (normalized) return normalized
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

const normalizePreset = (raw: unknown): Exclude<ExportDateRangePreset, 'custom'> | 'legacy90days' | null => {
  if (typeof raw !== 'string') return null
  const normalized = LEGACY_PRESET_MAP[raw]
  return normalized ?? null
}

export const resolveExportDateRangeConfig = (
  raw: ExportDefaultDateRangeConfig | string | null | undefined,
  now = new Date()
): ExportDateRangeSelection => {
  if (!raw) {
    return createDefaultExportDateRangeSelection()
  }

  if (typeof raw === 'string') {
    const preset = normalizePreset(raw)
    if (!preset) return createDefaultExportDateRangeSelection()
    if (preset === 'legacy90days') {
      return {
        preset: 'custom',
        useAllTime: false,
        dateRange: createDateRangeByLastNDays(90, now)
      }
    }
    return createExportDateRangeSelectionFromPreset(preset, now)
  }

  const preset = normalizePreset(raw.preset)
  if (raw.useAllTime || preset === 'all') {
    return createExportDateRangeSelectionFromPreset('all', now)
  }
  if (preset && preset !== 'legacy90days') {
    return createExportDateRangeSelectionFromPreset(preset, now)
  }

  if (preset === 'legacy90days') {
    return {
      preset: 'custom',
      useAllTime: false,
      dateRange: createDateRangeByLastNDays(90, now)
    }
  }

  const parsedStart = parseStoredDate(raw.start)
  const parsedEnd = parseStoredDate(raw.end)
  if (parsedStart && parsedEnd) {
    const start = parsedStart
    const end = parsedEnd
    return {
      preset: 'custom',
      useAllTime: false,
      dateRange: {
        start,
        end: end < start ? start : end
      }
    }
  }

  return createDefaultExportDateRangeSelection()
}

export const serializeExportDateRangeConfig = (
  selection: ExportDateRangeSelection
): ExportDefaultDateRangeConfig => {
  if (selection.useAllTime) {
    return {
      version: 1,
      preset: 'all',
      useAllTime: true
    }
  }

  if (selection.preset === 'custom') {
    return {
      version: 1,
      preset: 'custom',
      useAllTime: false,
      start: formatDateInputValue(selection.dateRange.start),
      end: formatDateInputValue(selection.dateRange.end)
    }
  }

  return {
    version: 1,
    preset: selection.preset,
    useAllTime: false
  }
}

export const getExportDateRangeLabel = (selection: ExportDateRangeSelection): string => {
  if (selection.useAllTime) return PRESET_LABELS.all
  if (selection.preset !== 'custom') return PRESET_LABELS[selection.preset]
  return `${formatDateInputValue(selection.dateRange.start)} 至 ${formatDateInputValue(selection.dateRange.end)}`
}
