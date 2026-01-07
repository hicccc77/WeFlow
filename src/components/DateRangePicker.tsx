import { useState, useRef, useEffect } from 'react'
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react'
import './DateRangePicker.scss'

interface DateRangePickerProps {
  startDate: string
  endDate: string
  onStartDateChange: (date: string) => void
  onEndDateChange: (date: string) => void
  onRangeComplete?: () => void
}

const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']

// 快捷选项
const QUICK_OPTIONS = [
  { label: '最近7天', days: 7 },
  { label: '最近30天', days: 30 },
  { label: '最近90天', days: 90 },
  { label: '最近一年', days: 365 },
  { label: '全部时间', days: 0 },
]

function DateRangePicker({ startDate, endDate, onStartDateChange, onEndDateChange, onRangeComplete }: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectingStart, setSelectingStart] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const formatDisplayDate = (dateStr: string) => {
    if (!dateStr) return ''
    const date = new Date(dateStr)
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }

  const getDisplayText = () => {
    if (!startDate && !endDate) return '选择时间范围'
    if (startDate && endDate) return `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`
    if (startDate) return `${formatDisplayDate(startDate)} - ?`
    return `? - ${formatDisplayDate(endDate)}`
  }

  const handleQuickOption = (days: number) => {
    if (days === 0) {
      onStartDateChange('')
      onEndDateChange('')
    } else {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - days)
      onStartDateChange(start.toISOString().split('T')[0])
      onEndDateChange(end.toISOString().split('T')[0])
    }
    setIsOpen(false)
    setTimeout(() => onRangeComplete?.(), 0)
  }

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    onStartDateChange('')
    onEndDateChange('')
  }


  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay()
  }

  const handleDateClick = (day: number) => {
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    
    if (selectingStart) {
      onStartDateChange(dateStr)
      if (endDate && dateStr > endDate) {
        onEndDateChange('')
      }
      setSelectingStart(false)
    } else {
      if (dateStr < startDate) {
        onStartDateChange(dateStr)
        onEndDateChange(startDate)
      } else {
        onEndDateChange(dateStr)
      }
      setSelectingStart(true)
      setIsOpen(false)
      setTimeout(() => onRangeComplete?.(), 0)
    }
  }

  const isInRange = (day: number) => {
    if (!startDate || !endDate) return false
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return dateStr >= startDate && dateStr <= endDate
  }

  const isStartDate = (day: number) => {
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return dateStr === startDate
  }

  const isEndDate = (day: number) => {
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return dateStr === endDate
  }

  const isToday = (day: number) => {
    const today = new Date()
    return currentMonth.getFullYear() === today.getFullYear() &&
           currentMonth.getMonth() === today.getMonth() &&
           day === today.getDate()
  }

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(currentMonth)
    const firstDay = getFirstDayOfMonth(currentMonth)
    const days: (number | null)[] = []

    for (let i = 0; i < firstDay; i++) {
      days.push(null)
    }
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i)
    }

    return (
      <div className="calendar-grid">
        {WEEKDAY_NAMES.map(name => (
          <div key={name} className="weekday-header">{name}</div>
        ))}
        {days.map((day, index) => (
          <div
            key={index}
            className={`calendar-day ${day ? 'valid' : ''} ${day && isInRange(day) ? 'in-range' : ''} ${day && isStartDate(day) ? 'start' : ''} ${day && isEndDate(day) ? 'end' : ''} ${day && isToday(day) ? 'today' : ''}`}
            onClick={() => day && handleDateClick(day)}
          >
            {day}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="date-range-picker" ref={containerRef}>
      <button className="picker-trigger" onClick={() => setIsOpen(!isOpen)}>
        <Calendar size={14} />
        <span className="picker-text">{getDisplayText()}</span>
        {(startDate || endDate) && (
          <button className="clear-btn" onClick={handleClear}>
            <X size={12} />
          </button>
        )}
      </button>

      {isOpen && (
        <div className="picker-dropdown">
          <div className="quick-options">
            {QUICK_OPTIONS.map(opt => (
              <button key={opt.label} className="quick-option" onClick={() => handleQuickOption(opt.days)}>
                {opt.label}
              </button>
            ))}
          </div>
          <div className="calendar-section">
            <div className="calendar-header">
              <button className="nav-btn" onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1))}>
                <ChevronLeft size={16} />
              </button>
              <span className="month-year">{currentMonth.getFullYear()}年 {MONTH_NAMES[currentMonth.getMonth()]}</span>
              <button className="nav-btn" onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1))}>
                <ChevronRight size={16} />
              </button>
            </div>
            {renderCalendar()}
            <div className="selection-hint">
              {selectingStart ? '请选择开始日期' : '请选择结束日期'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DateRangePicker
