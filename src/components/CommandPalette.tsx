import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, MessageSquare, BarChart3, Users, BookOpen, Settings, FileText, Network } from 'lucide-react'
import './CommandPalette.scss'

interface PaletteItem {
  id: string
  label: string
  category: 'page' | 'contact' | 'action'
  icon: React.ReactNode
  hint?: string
  action: () => void
}

const PAGES: Array<{ id: string; label: string; path: string; icon: React.ReactNode; hint: string }> = [
  { id: 'assistant', label: '沟通助手', path: '/assistant', icon: <MessageSquare size={16} />, hint: 'AI 回复建议' },
  { id: 'content', label: '内容中心', path: '/content', icon: <BookOpen size={16} />, hint: '公众号/链接/文件' },
  { id: 'chat', label: '聊天记录', path: '/chat', icon: <MessageSquare size={16} />, hint: '消息浏览' },
  { id: 'graph', label: '社交图谱', path: '/graph', icon: <Network size={16} />, hint: '关系网络' },
  { id: 'analytics', label: '数据分析', path: '/analytics', icon: <BarChart3 size={16} />, hint: '消息统计' },
  { id: 'contacts', label: '通讯录', path: '/contacts', icon: <Users size={16} />, hint: '联系人列表' },
  { id: 'export', label: '数据导出', path: '/export', icon: <FileText size={16} />, hint: '导出消息' },
  { id: 'settings', label: '设置', path: '/settings', icon: <Settings size={16} />, hint: '应用配置' },
  { id: 'coach-log', label: '教练日志', path: '/coach-log', icon: <BookOpen size={16} />, hint: 'AI 分析记录' },
]

function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filteredItems = useMemo(() => {
    const items: PaletteItem[] = []
    const q = query.toLowerCase().trim()

    // Filter pages
    const matchingPages = PAGES.filter(p =>
      !q || p.label.toLowerCase().includes(q) || p.hint.toLowerCase().includes(q) || p.id.includes(q)
    )
    for (const p of matchingPages) {
      items.push({
        id: `page:${p.id}`,
        label: p.label,
        category: 'page',
        icon: p.icon,
        hint: p.hint,
        action: () => {
          navigate(p.path)
          onClose()
        },
      })
    }

    return items
  }, [query, navigate, onClose])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, filteredItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredItems[activeIndex]) {
        filteredItems[activeIndex].action()
      }
    }
  }, [filteredItems, activeIndex, onClose])

  let currentCategory = ''

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <div className="palette-input-wrapper">
          <Search size={18} className="palette-icon" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索页面、联系人..."
          />
          <span className="palette-shortcut">ESC</span>
        </div>
        <div className="palette-results">
          {filteredItems.length === 0 ? (
            <div className="palette-empty">没有匹配结果</div>
          ) : (
            filteredItems.map((item, i) => {
              const categoryLabel = item.category === 'page' ? '页面' : item.category === 'contact' ? '联系人' : '操作'
              const showCategory = categoryLabel !== currentCategory
              if (showCategory) currentCategory = categoryLabel

              return (
                <div key={item.id}>
                  {showCategory && <div className="palette-category">{categoryLabel}</div>}
                  <div
                    className={`palette-item ${i === activeIndex ? 'active' : ''}`}
                    onClick={() => item.action()}
                    onMouseEnter={() => setActiveIndex(i)}
                  >
                    <span className="item-icon">{item.icon}</span>
                    <span className="item-text">{item.label}</span>
                    {item.hint && <span className="item-hint">{item.hint}</span>}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
