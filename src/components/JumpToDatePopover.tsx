import React, { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import './JumpToDatePopover.scss'

interface JumpToDatePopoverProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (date: Date) => void
  onMonthChange?: (date: Date) => void
  className?: string
  style?: React.CSSProperties
  currentDate?: Date
  messageDates?: Set<string>
  hasLoadedMessageDates?: boolean
  messageDateCounts?: Record<string, number>
  loadingDates?: boolean
  loadingDateCounts?: boolean
}

const JumpToDatePopover: React.FC<JumpToDatePopoverProps> = ({
  isOpen,
  onClose,
  onSelect,
  onMonthChange,
  className,
  style,
  currentDate = new Date(),
  messageDates,
  hasLoadedMessageDates = false,
  messageDateCounts,
  loadingDates = false,
  loadingDateCounts = false
}) => {
  type CalendarViewMode = 'day' | 'month' | 'year'
  const getYearPageStart = (year: number): number => Math.floor(year / 12) * 12
  const [calendarDate, setCalendarDate] = useState<Date>(new Date(currentDate))
  const [selectedDate, setSelectedDate] = useState<Date>(new Date(currentDate))
  const [viewMode, setViewMode] = useState<CalendarViewMode>('day')
  const [yearPageStart, setYearPageStart] = useState<number>(getYearPageStart(new Date(currentDate).getFullYear()))

  useEffect(() => {
    if (!isOpen) return
    const normalized = new Date(currentDate)
    setCalendarDate(normalized)
    setSelectedDate(normalized)
    setViewMode('day')
    setYearPageStart(getYearPageStart(normalized.getFullYear()))
  }, [isOpen, currentDate])

  if (!isOpen) return null

  const getDaysInMonth = (date: Date): number => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date: Date): number => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month, 1).getDay()
  }

  const toDateKey = (day: number): string => {
    const year = calendarDate.getFullYear()
    const month = calendarDate.getMonth() + 1
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const hasMessage = (day: number): boolean => {
    if (!hasLoadedMessageDates) return true
    if (!messageDates || messageDates.size === 0) return false
    return messageDates.has(toDateKey(day))
  }

  const isToday = (day: number): boolean => {
    const today = new Date()
    return day === today.getDate()
      && calendarDate.getMonth() === today.getMonth()
      && calendarDate.getFullYear() === today.getFullYear()
  }

  const isSelected = (day: number): boolean => {
    return day === selectedDate.getDate()
      && calendarDate.getMonth() === selectedDate.getMonth()
      && calendarDate.getFullYear() === selectedDate.getFullYear()
  }

  const generateCalendar = (): Array<number | null> => {
    const daysInMonth = getDaysInMonth(calendarDate)
    const firstDay = getFirstDayOfMonth(calendarDate)
    const days: Array<number | null> = []

    for (let i = 0; i < firstDay; i++) {
      days.push(null)
    }
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i)
    }
    return days
  }

  const handleDateClick = (day: number) => {
    if (hasLoadedMessageDates && !hasMessage(day)) return
    const targetDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), day)
    setSelectedDate(targetDate)
    onSelect(targetDate)
    onClose()
  }

  const getDayClassName = (day: number | null): string => {
    if (day === null) return 'day-cell empty'
    const classes = ['day-cell']
    if (isToday(day)) classes.push('today')
    if (isSelected(day)) classes.push('selected')
    if (hasLoadedMessageDates && !hasMessage(day)) classes.push('no-message')
    return classes.join(' ')
  }

  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  const days = generateCalendar()
  const mergedClassName = ['jump-date-popover', className || ''].join(' ').trim()

  const updateCalendarDate = (nextDate: Date) => {
    setCalendarDate(nextDate)
    onMonthChange?.(nextDate)
  }

  const openMonthView = () => setViewMode('month')
  const openYearView = () => {
    setYearPageStart(getYearPageStart(calendarDate.getFullYear()))
    setViewMode('year')
  }

  const handleTitleClick = () => {
    if (viewMode === 'day') {
      openMonthView()
      return
    }
    if (viewMode === 'month') {
      openYearView()
    }
  }

  const handlePrev = () => {
    if (viewMode === 'day') {
      updateCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1))
      return
    }
    if (viewMode === 'month') {
      updateCalendarDate(new Date(calendarDate.getFullYear() - 1, calendarDate.getMonth(), 1))
      return
    }
    setYearPageStart((prev) => prev - 12)
  }

  const handleNext = () => {
    if (viewMode === 'day') {
      updateCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1))
      return
    }
    if (viewMode === 'month') {
      updateCalendarDate(new Date(calendarDate.getFullYear() + 1, calendarDate.getMonth(), 1))
      return
    }
    setYearPageStart((prev) => prev + 12)
  }

  const navTitle = viewMode === 'day'
    ? `${calendarDate.getFullYear()}年${calendarDate.getMonth() + 1}月`
    : viewMode === 'month'
      ? `${calendarDate.getFullYear()}年`
      : `${yearPageStart}年 - ${yearPageStart + 11}年`

  return (
    <div className={mergedClassName} style={style} role="dialog" aria-label="跳转日期">
      <div className="calendar-nav">
        <button
          className="nav-btn"
          onClick={handlePrev}
          aria-label="上一月"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className={`current-month ${viewMode === 'year' ? '' : 'clickable'}`.trim()}
          onClick={handleTitleClick}
          type="button"
        >
          {navTitle}
        </button>
        <button
          className="nav-btn"
          onClick={handleNext}
          aria-label="下一月"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="status-line">
        {loadingDates && (
          <span className="status-item">
            <Loader2 size={12} className="spin" />
            <span>日期加载中</span>
          </span>
        )}
        {!loadingDates && loadingDateCounts && (
          <span className="status-item">
            <Loader2 size={12} className="spin" />
            <span>条数加载中</span>
          </span>
        )}
      </div>

      {viewMode === 'day' && (
        <div className="calendar-grid">
          <div className="weekdays">
            {weekdays.map(day => (
              <div key={day} className="weekday">{day}</div>
            ))}
          </div>
          <div className="days">
            {days.map((day, index) => {
              if (day === null) return <div key={index} className="day-cell empty" />
              const dateKey = toDateKey(day)
              const hasMessageOnDay = hasMessage(day)
              const count = Number(messageDateCounts?.[dateKey] || 0)
              const showCount = count > 0
              const showCountLoading = hasMessageOnDay && loadingDateCounts && !showCount
              return (
                <button
                  key={index}
                  className={getDayClassName(day)}
                  onClick={() => handleDateClick(day)}
                  disabled={hasLoadedMessageDates && !hasMessageOnDay}
                  type="button"
                >
                  <span className="day-number">{day}</span>
                  {showCount && <span className="day-count">{count}</span>}
                  {showCountLoading && <Loader2 size={11} className="day-count-loading spin" />}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {viewMode === 'month' && (
        <div className="month-grid">
          {['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'].map((name, monthIndex) => (
            <button
              key={name}
              className={`month-cell ${monthIndex === calendarDate.getMonth() ? 'active' : ''}`}
              onClick={() => {
                updateCalendarDate(new Date(calendarDate.getFullYear(), monthIndex, 1))
                setViewMode('day')
              }}
              type="button"
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {viewMode === 'year' && (
        <div className="year-grid">
          {Array.from({ length: 12 }, (_, i) => yearPageStart + i).map((year) => (
            <button
              key={year}
              className={`year-cell ${year === calendarDate.getFullYear() ? 'active' : ''}`}
              onClick={() => {
                updateCalendarDate(new Date(year, calendarDate.getMonth(), 1))
                setViewMode('month')
              }}
              type="button"
            >
              {year}年
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default JumpToDatePopover
