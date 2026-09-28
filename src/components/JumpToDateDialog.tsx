import React, { useState } from 'react'
import { X, ChevronLeft, ChevronRight, Calendar as CalendarIcon, Loader2 } from 'lucide-react'
import './JumpToDateDialog.scss'

interface JumpToDateDialogProps {
    isOpen: boolean
    onClose: () => void
    onSelect: (date: Date) => void
    currentDate?: Date
    /** 有消息的日期集合，格式为 YYYY-MM-DD */
    messageDates?: Set<string>
    /** 是否正在加载消息日期 */
    loadingDates?: boolean
}

const JumpToDateDialog: React.FC<JumpToDateDialogProps> = ({
    isOpen,
    onClose,
    onSelect,
    currentDate = new Date(),
    messageDates,
    loadingDates = false
}) => {
    type CalendarViewMode = 'day' | 'month' | 'year'
    const getYearPageStart = (year: number): number => Math.floor(year / 12) * 12
    const isValidDate = (d: any) => d instanceof Date && !isNaN(d.getTime())
    const [calendarDate, setCalendarDate] = useState(isValidDate(currentDate) ? new Date(currentDate) : new Date())
    const [selectedDate, setSelectedDate] = useState(new Date(currentDate))
    const [viewMode, setViewMode] = useState<CalendarViewMode>('day')
    const [yearPageStart, setYearPageStart] = useState<number>(
        getYearPageStart((isValidDate(currentDate) ? new Date(currentDate) : new Date()).getFullYear())
    )

    if (!isOpen) return null

    const getDaysInMonth = (date: Date) => {
        const year = date.getFullYear()
        const month = date.getMonth()
        return new Date(year, month + 1, 0).getDate()
    }

    const getFirstDayOfMonth = (date: Date) => {
        const year = date.getFullYear()
        const month = date.getMonth()
        return new Date(year, month, 1).getDay()
    }

    const generateCalendar = () => {
        const daysInMonth = getDaysInMonth(calendarDate)
        const firstDay = getFirstDayOfMonth(calendarDate)
        const days: (number | null)[] = []

        for (let i = 0; i < firstDay; i++) {
            days.push(null)
        }

        for (let i = 1; i <= daysInMonth; i++) {
            days.push(i)
        }

        return days
    }

    /**
     * 判断某天是否有消息
     */
    const hasMessage = (day: number): boolean => {
        if (!messageDates || messageDates.size === 0) return true // 未加载时默认全部可点击
        const year = calendarDate.getFullYear()
        const month = calendarDate.getMonth() + 1
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        return messageDates.has(dateStr)
    }

    const handleDateClick = (day: number) => {
        // 如果已加载日期数据且该日期无消息，则不可点击
        if (messageDates && messageDates.size > 0 && !hasMessage(day)) return
        const newDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), day)
        setSelectedDate(newDate)
    }

    const handleConfirm = () => {
        onSelect(selectedDate)
        onClose()
    }

    const isToday = (day: number) => {
        const today = new Date()
        return day === today.getDate() &&
            calendarDate.getMonth() === today.getMonth() &&
            calendarDate.getFullYear() === today.getFullYear()
    }

    const isSelected = (day: number) => {
        return day === selectedDate.getDate() &&
            calendarDate.getMonth() === selectedDate.getMonth() &&
            calendarDate.getFullYear() === selectedDate.getFullYear()
    }

    /**
     * 获取某天的 CSS 类名
     */
    const getDayClassName = (day: number | null): string => {
        if (day === null) return 'day-cell empty'

        const classes = ['day-cell']
        if (isSelected(day)) classes.push('selected')
        if (isToday(day)) classes.push('today')

        // 仅在已加载消息日期数据时区分有/无消息
        if (messageDates && messageDates.size > 0) {
            if (hasMessage(day)) {
                classes.push('has-message')
            } else {
                classes.push('no-message')
            }
        }

        return classes.join(' ')
    }

    const weekdays = ['日', '一', '二', '三', '四', '五', '六']
    const days = generateCalendar()
    const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']

    const updateCalendarDate = (nextDate: Date) => {
        setCalendarDate(nextDate)
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
        <div className="jump-date-overlay" onClick={onClose}>
            <div className="jump-date-modal" onClick={e => e.stopPropagation()}>
                <div className="jump-date-header">
                    <div className="title-area">
                        <CalendarIcon size={18} />
                        <h3>跳转到日期</h3>
                    </div>
                    <button className="close-btn" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>

                <div className="calendar-view">
                    <div className="calendar-nav">
                        <button
                            className="nav-btn"
                            onClick={handlePrev}
                        >
                            <ChevronLeft size={18} />
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
                        >
                            <ChevronRight size={18} />
                        </button>
                    </div>

                    {viewMode === 'month' ? (
                        <div className="year-month-picker">
                            <div className="month-grid">
                                {monthNames.map((name, i) => (
                                    <button
                                        key={i}
                                        className={`month-btn ${i === calendarDate.getMonth() ? 'active' : ''}`}
                                        onClick={() => {
                                            updateCalendarDate(new Date(calendarDate.getFullYear(), i, 1))
                                            setViewMode('day')
                                        }}
                                    >{name}</button>
                                ))}
                            </div>
                        </div>
                    ) : viewMode === 'year' ? (
                        <div className="year-month-picker">
                            <div className="year-grid">
                                {Array.from({ length: 12 }, (_, i) => yearPageStart + i).map((year) => (
                                    <button
                                        key={year}
                                        className={`year-btn ${year === calendarDate.getFullYear() ? 'active' : ''}`}
                                        onClick={() => {
                                            updateCalendarDate(new Date(year, calendarDate.getMonth(), 1))
                                            setViewMode('month')
                                        }}
                                    >
                                        {year}年
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                    <div className={`calendar-grid ${loadingDates ? 'loading' : ''}`}>
                        {loadingDates && (
                            <div className="calendar-loading">
                                <Loader2 size={20} className="spin" />
                                <span>正在加载...</span>
                            </div>
                        )}
                        <div className="weekdays" style={{ visibility: loadingDates ? 'hidden' : 'visible' }}>
                            {weekdays.map(d => <div key={d} className="weekday">{d}</div>)}
                        </div>
                        <div className="days" style={{ visibility: loadingDates ? 'hidden' : 'visible' }}>
                            {days.map((day, i) => (
                                <div
                                    key={i}
                                    className={getDayClassName(day)}
                                    style={{ visibility: loadingDates ? 'hidden' : 'visible' }}
                                    onClick={() => day !== null && handleDateClick(day)}
                                >
                                    {day}
                                    {day !== null && messageDates && messageDates.size > 0 && hasMessage(day) && (
                                        <span className="message-dot" />
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                    )}
                </div>

                <div className="quick-options">
                    <button onClick={() => {
                        const d = new Date()
                        setSelectedDate(d)
                        setCalendarDate(new Date(d))
                        setViewMode('day')
                    }}>今天</button>
                    <button onClick={() => {
                        const d = new Date()
                        d.setDate(d.getDate() - 7)
                        setSelectedDate(d)
                        setCalendarDate(new Date(d))
                        setViewMode('day')
                    }}>一周前</button>
                    <button onClick={() => {
                        const d = new Date()
                        d.setMonth(d.getMonth() - 1)
                        setSelectedDate(d)
                        setCalendarDate(new Date(d))
                        setViewMode('day')
                    }}>一月前</button>
                </div>

                <div className="dialog-footer">
                    <button className="cancel-btn" onClick={onClose}>取消</button>
                    <button className="confirm-btn" onClick={handleConfirm}>跳转</button>
                </div>
            </div>
        </div>
    )
}

export default JumpToDateDialog
