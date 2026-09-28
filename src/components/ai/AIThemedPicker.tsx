import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Popover } from '@heroui/react'
import { Check, ChevronDown, Search } from 'lucide-react'

export interface AIThemedPickerOption {
  value: string
  label: string
  description?: string
  keywords?: string
  icon?: ReactNode
  group?: string
  badge?: string
}

interface AIThemedPickerProps {
  ariaLabel: string
  value: string
  options: AIThemedPickerOption[]
  placeholder: string
  onChange: (value: string) => void
  allowCustomValue?: boolean
  className?: string
  customValueDescription?: string
  emptyText?: string
  searchPlaceholder?: string
  searchable?: boolean
  triggerLabel?: ReactNode
}

export default function AIThemedPicker({
  ariaLabel,
  value,
  options,
  placeholder,
  onChange,
  allowCustomValue = false,
  className = '',
  customValueDescription = '使用自定义值',
  emptyText = '没有匹配项',
  searchPlaceholder = '搜索…',
  searchable = true,
  triggerLabel,
}: AIThemedPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [popoverWidth, setPopoverWidth] = useState<number>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const firstOptionRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const selectedOption = options.find((option) => option.value === value)

  const orderedOptions = useMemo(() => {
    // Grouped pickers keep their semantic order. Moving the selected item to
    // the top would split a group and make its heading misleading.
    if (!selectedOption || options.some((option) => option.group)) return options
    return [selectedOption, ...options.filter((option) => option.value !== selectedOption.value)]
  }, [options, selectedOption])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return orderedOptions
    return orderedOptions.filter((option) => (
      `${option.label} ${option.value} ${option.description || ''} ${option.keywords || ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ))
  }, [normalizedQuery, orderedOptions])
  const customValue = query.trim()
  const showCustomValue = allowCustomValue
    && Boolean(customValue)
    && !options.some((option) => option.value.toLocaleLowerCase() === customValue.toLocaleLowerCase())

  useEffect(() => {
    if (!isOpen || !searchable) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [isOpen, searchable])

  const close = () => {
    setIsOpen(false)
    setQuery('')
  }

  const choose = (nextValue: string) => {
    onChange(nextValue)
    close()
  }

  const handleOpenChange = (open: boolean) => {
    if (open) setPopoverWidth(triggerRef.current?.getBoundingClientRect().width)
    setIsOpen(open)
    if (!open) setQuery('')
  }

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      firstOptionRef.current?.focus()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (filteredOptions[0]) choose(filteredOptions[0].value)
    else if (showCustomValue) choose(customValue)
  }

  return (
    <Popover isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Button
        ref={triggerRef}
        aria-controls={listId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={`ai-themed-picker-trigger ${className}`.trim()}
        fullWidth
        render={(buttonProps) => <button {...buttonProps} type="button" />}
        variant="secondary"
        onPress={() => {
          setPopoverWidth(triggerRef.current?.getBoundingClientRect().width)
          setIsOpen(true)
        }}
      >
        {selectedOption?.icon && <span className="ai-themed-picker-trigger-icon">{selectedOption.icon}</span>}
        <span className={selectedOption || value ? 'ai-themed-picker-trigger-label' : 'ai-themed-picker-trigger-label is-placeholder'}>
          {(triggerLabel ?? selectedOption?.label ?? value) || placeholder}
        </span>
        {selectedOption?.badge && <span className="ai-themed-picker-badge">{selectedOption.badge}</span>}
        <ChevronDown aria-hidden="true" className="ai-themed-picker-chevron" size={15} />
      </Button>
      <Popover.Content
        className="ai-themed-picker-popover p-0"
        offset={6}
        placement="bottom start"
        shouldFlip
        style={{ width: popoverWidth }}
      >
        <Popover.Dialog aria-label={ariaLabel} className="p-0">
          {searchable && (
            <div className="ai-themed-picker-search">
              <Search aria-hidden="true" size={15} />
              <input
                ref={searchInputRef}
                aria-controls={listId}
                aria-label={searchPlaceholder}
                className="ai-themed-picker-search-input"
                placeholder={searchPlaceholder}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </div>
          )}
          <div aria-label={`${ariaLabel}选项`} className="ai-themed-picker-list" id={listId} role="listbox">
            {filteredOptions.map((option, index) => {
              const previousGroup = index > 0 ? filteredOptions[index - 1]?.group : undefined
              const showGroup = Boolean(option.group && option.group !== previousGroup)
              return (
                <Fragment key={option.value}>
                  {showGroup && <span className="ai-themed-picker-group-label" role="presentation">{option.group}</span>}
                  <button
                    ref={index === 0 ? firstOptionRef : undefined}
                    aria-selected={option.value === value}
                    className="ai-themed-picker-option"
                    role="option"
                    type="button"
                    onClick={() => choose(option.value)}
                  >
                    {option.icon && <span className="ai-themed-picker-option-icon">{option.icon}</span>}
                    <span className="ai-themed-picker-option-copy">
                      <span className="ai-themed-picker-option-title">
                        <strong>{option.label}</strong>
                        {option.badge && <span className="ai-themed-picker-badge">{option.badge}</span>}
                      </span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {option.value === value && <Check aria-hidden="true" className="ai-themed-picker-check" size={15} />}
                  </button>
                </Fragment>
              )
            })}
            {showCustomValue && (
              <button
                ref={filteredOptions.length === 0 ? firstOptionRef : undefined}
                aria-selected={false}
                className="ai-themed-picker-option ai-themed-picker-custom-option"
                role="option"
                type="button"
                onClick={() => choose(customValue)}
              >
                <span className="ai-themed-picker-option-copy">
                  <strong>{customValue}</strong>
                  <small>{customValueDescription}</small>
                </span>
              </button>
            )}
            {!showCustomValue && filteredOptions.length === 0 && (
              <span className="ai-themed-picker-empty">{emptyText}</span>
            )}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}
