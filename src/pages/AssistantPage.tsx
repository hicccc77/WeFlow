import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Star, Mail, VolumeX, Send, ChevronDown, ChevronUp, Sparkles, MessageSquare, Eye, TrendingUp, Copy, Edit2, Bug, X, RefreshCw, Loader2 } from 'lucide-react'
import { useAssistantStore, type ContactWithStatus } from '../stores/assistantStore'
import { useAppStore } from '../stores/appStore'
import './AssistantPage.scss'

function AssistantPage() {
  const navigate = useNavigate()
  const isDbConnected = useAppStore(state => state.isDbConnected)
  const {
    contacts,
    selectedContact,
    analysisResult,
    discussionRounds,
    replySuggestions,
    isAnalyzing,
    isDiscussing,
    error,
    searchQuery,
    searchResults,
    briefing,
    showDiscussionPanel,
    contextData,
    loadContacts,
    selectContact,
    discuss,
    generateReplies,
    search,
    loadBriefing,
    toggleDiscussionPanel,
    starContact,
    ignoreContact,
    clearError,
  } = useAssistantStore()

  const [discussInput, setDiscussInput] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [editingSuggestion, setEditingSuggestion] = useState<number | null>(null)
  const [editedContent, setEditedContent] = useState('')
  const [isGeneratingBriefing, setIsGeneratingBriefing] = useState(false)
  const discussEndRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const handleGenerateBriefing = useCallback(async () => {
    setIsGeneratingBriefing(true)
    try {
      await window.electronAPI.intel.generateBriefing()
      await loadBriefing()
    } catch (e) {
      console.error('Failed to generate briefing:', e)
    } finally {
      setIsGeneratingBriefing(false)
    }
  }, [loadBriefing])

  const [replyQueue, setReplyQueue] = useState<Array<{ contact: string; name: string; message: string; priority: number; reason: string }>>([])

  useEffect(() => {
    loadContacts()
    loadBriefing()
    // E1: Load reply queue
    window.electronAPI.intel.getReplyQueue()
      .then(result => { if (Array.isArray(result)) setReplyQueue(result) })
      .catch(() => {})
  }, [loadContacts, loadBriefing])

  useEffect(() => {
    discussEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [discussionRounds])

  const handleDiscussSubmit = useCallback(() => {
    if (!discussInput.trim() || isDiscussing) return
    discuss(discussInput)
    setDiscussInput('')
  }, [discussInput, isDiscussing, discuss])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleDiscussSubmit()
    }
  }

  const handleApplySuggestion = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      // Fallback for clipboard API failure
      const textarea = document.createElement('textarea')
      textarea.value = content
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
  }

  const handleEditSuggestion = (index: number, content: string) => {
    setEditingSuggestion(index)
    setEditedContent(content)
  }

  const handleSearchFocus = () => {
    setShowSearchDropdown(true)
  }

  const handleSearchBlur = () => {
    setTimeout(() => setShowSearchDropdown(false), 200)
  }

  const selectedContactData = contacts.find(c => c.id === selectedContact)

  // Group contacts
  const starredContacts = contacts.filter(c => c.starred && !c.ignored)
  const pendingContacts = contacts.filter(c => !c.starred && !c.ignored && c.unread > 0)
  const ignoredContacts = contacts.filter(c => c.ignored)
  const otherContacts = contacts.filter(c => !c.starred && !c.ignored && c.unread === 0)

  // Welcome page when not connected
  if (!isDbConnected) {
    return (
      <div className="assistant-page assistant-welcome">
        <div className="welcome-container">
          <div className="welcome-icon">
            <Sparkles size={48} />
          </div>
          <h1 className="welcome-title">你的智能沟通助手</h1>
          <p className="welcome-subtitle">AI-powered communication assistant</p>
          <div className="welcome-features">
            <div className="feature-card" style={{ animationDelay: '0.1s' }}>
              <MessageSquare size={24} />
              <h3>每日简报</h3>
              <p>自动汇总未回复消息和重要联系人动态</p>
            </div>
            <div className="feature-card" style={{ animationDelay: '0.2s' }}>
              <Send size={24} />
              <h3>智能回复</h3>
              <p>AI分析对话上下文，生成三种风格的回复建议</p>
            </div>
            <div className="feature-card" style={{ animationDelay: '0.3s' }}>
              <Eye size={24} />
              <h3>关系洞察</h3>
              <p>了解联系人性格画像和沟通偏好</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="assistant-page">
      {/* Left Column - Contact List */}
      <div className="assistant-left-col">
        <div className="contact-search-wrap">
          <div className="contact-search">
            <Search size={16} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索联系人..."
              value={searchQuery}
              onChange={e => search(e.target.value)}
              onFocus={handleSearchFocus}
              onBlur={handleSearchBlur}
            />
            {searchQuery && (
              <button className="search-clear" onClick={() => search('')}>
                <X size={14} />
              </button>
            )}
          </div>
          {showSearchDropdown && (searchQuery ? searchResults : contacts.slice(0, 5)).length > 0 && (
            <div className="search-dropdown">
              {(searchQuery ? searchResults : contacts.slice(0, 5)).map(c => (
                <button
                  key={c.id}
                  className="search-dropdown-item"
                  onMouseDown={() => {
                    selectContact(c.id)
                    search('')
                    setShowSearchDropdown(false)
                  }}
                >
                  <div className="contact-avatar-sm">{c.name[0]}</div>
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="contact-list">
          {starredContacts.length > 0 && (
            <div className="contact-group">
              <div className="contact-group-label"><Star size={12} /> 星标联系人</div>
              {starredContacts.map(c => (
                <ContactItem
                  key={c.id}
                  contact={c}
                  isSelected={selectedContact === c.id}
                  onSelect={() => selectContact(c.id)}
                  onStar={() => starContact(c.id)}
                  onIgnore={() => ignoreContact(c.id)}
                />
              ))}
            </div>
          )}

          {pendingContacts.length > 0 && (
            <div className="contact-group">
              <div className="contact-group-label"><Mail size={12} /> 待回复</div>
              {pendingContacts.map(c => (
                <ContactItem
                  key={c.id}
                  contact={c}
                  isSelected={selectedContact === c.id}
                  onSelect={() => selectContact(c.id)}
                  onStar={() => starContact(c.id)}
                  onIgnore={() => ignoreContact(c.id)}
                />
              ))}
            </div>
          )}

          {otherContacts.length > 0 && (
            <div className="contact-group">
              <div className="contact-group-label">其他联系人</div>
              {otherContacts.map(c => (
                <ContactItem
                  key={c.id}
                  contact={c}
                  isSelected={selectedContact === c.id}
                  onSelect={() => selectContact(c.id)}
                  onStar={() => starContact(c.id)}
                  onIgnore={() => ignoreContact(c.id)}
                />
              ))}
            </div>
          )}

          {ignoredContacts.length > 0 && (
            <div className="contact-group">
              <div className="contact-group-label"><VolumeX size={12} /> 已忽略</div>
              {ignoredContacts.map(c => (
                <ContactItem
                  key={c.id}
                  contact={c}
                  isSelected={selectedContact === c.id}
                  onSelect={() => selectContact(c.id)}
                  onStar={() => starContact(c.id)}
                  onIgnore={() => ignoreContact(c.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Middle Column - Main Content */}
      <div className="assistant-mid-col">
        {/* Error Banner */}
        {error && (
          <div className="assistant-error-banner">
            <span>{error}</span>
            <button className="error-dismiss" onClick={clearError}><X size={14} /></button>
          </div>
        )}
        {/* Daily Briefing Hero */}
        {!briefing && !selectedContact && (
          <div className="briefing-hero" style={{ textAlign: 'center', padding: '32px' }}>
            <Sparkles size={32} style={{ color: '#999', marginBottom: '12px' }} />
            <h3 style={{ color: '#666', marginBottom: '8px' }}>暂无每日简报</h3>
            <p style={{ color: '#999', marginBottom: '16px', fontSize: '14px' }}>分析最近 24 小时的消息，生成待办、日程和联系人动态</p>
            <button
              className="btn btn-primary"
              onClick={handleGenerateBriefing}
              disabled={isGeneratingBriefing}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
            >
              {isGeneratingBriefing ? <Loader2 size={16} className="spinning" /> : <Sparkles size={16} />}
              {isGeneratingBriefing ? '正在生成...' : '生成每日简报'}
            </button>
          </div>
        )}
        {briefing && !selectedContact && (
          <div className="briefing-hero">
            <div className="briefing-header">
              <Sparkles size={20} />
              <h2>每日简报</h2>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleGenerateBriefing}
                disabled={isGeneratingBriefing}
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}
              >
                {isGeneratingBriefing ? <Loader2 size={12} className="spinning" /> : <RefreshCw size={12} />}
                {isGeneratingBriefing ? '生成中...' : '刷新'}
              </button>
            </div>
            <p className="briefing-summary">{briefing.summary}</p>
            <div className="briefing-stats">
              <div className="briefing-stat">
                <span className="stat-value">{briefing.unrepliedCount}</span>
                <span className="stat-label">未回复</span>
              </div>
              <div className="briefing-stat">
                <span className="stat-value">{briefing.topContacts.length}</span>
                <span className="stat-label">活跃联系人</span>
              </div>
              <div className="briefing-stat">
                <span className="stat-value">{briefing.todos.length}</span>
                <span className="stat-label">待办事项</span>
              </div>
            </div>
            {briefing.todos.length > 0 && (
              <div className="briefing-todos">
                <h4>待办事项</h4>
                <ul>
                  {briefing.todos.map((todo, i) => (
                    <li key={i}>{todo}</li>
                  ))}
                </ul>
              </div>
            )}
            {briefing.topContacts.length > 0 && (
              <div className="briefing-top-contacts">
                <h4>活跃联系人</h4>
                <div className="top-contact-chips">
                  {briefing.topContacts.map((tc, i) => (
                    <span key={i} className="top-contact-chip">
                      {tc.name} <small>({tc.count}条)</small>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* E1: Smart Reply Queue */}
        {replyQueue.length > 0 && !selectedContact && (
          <div className="reply-queue" style={{ padding: '16px 24px' }}>
            <h3 style={{ fontSize: '14px', color: '#666', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Mail size={16} /> 需要回复 ({replyQueue.length})
            </h3>
            <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '8px' }}>
              {replyQueue.map((item, i) => (
                <div
                  key={i}
                  onClick={() => selectContact(item.contact)}
                  style={{
                    minWidth: '200px', maxWidth: '240px', padding: '12px 16px',
                    background: '#FFFFFF', borderRadius: '8px', cursor: 'pointer',
                    border: '1px solid #EBEBEB', flexShrink: 0,
                  }}
                >
                  <div style={{ fontSize: '14px', fontWeight: 500, color: '#1A1A1A', marginBottom: '4px' }}>{item.name}</div>
                  <div style={{ fontSize: '12px', color: '#999', marginBottom: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.message || '...'}</div>
                  <div style={{ fontSize: '11px', color: '#00C853' }}>{item.reason}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Selected Contact View */}
        {selectedContact && selectedContactData && (
          <div className="assistant-conversation">
            <div className="conversation-header">
              <div className="contact-avatar-lg">{selectedContactData.name[0]}</div>
              <div className="conversation-header-info">
                <h2>{selectedContactData.name}</h2>
                <p className="last-message">{selectedContactData.lastMessage}</p>
              </div>
            </div>

            {/* Analysis Result */}
            {isAnalyzing ? (
              <div className="analysis-loading">
                <div className="loading-spinner" />
                <span>AI 正在分析对话...</span>
              </div>
            ) : analysisResult && (
              <div className="analysis-result">
                <div className="analysis-badge">
                  <TrendingUp size={14} />
                  <span>{analysisResult.isComplex ? '复杂对话' : '日常消息'}</span>
                </div>
                <p>{analysisResult.reason}</p>
              </div>
            )}

            {/* Discussion Panel */}
            <div className="discussion-section">
              <button className="discussion-toggle" onClick={toggleDiscussionPanel}>
                <MessageSquare size={16} />
                <span>对话教练</span>
                {showDiscussionPanel ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {showDiscussionPanel && (
                <div className="discussion-panel">
                  <div className="discussion-messages">
                    {discussionRounds.length === 0 && (
                      <div className="discussion-empty">
                        <p>描述你想表达的意思，AI会帮你优化回复</p>
                      </div>
                    )}
                    {discussionRounds.map((round, i) => (
                      <div key={i} className={`discussion-message ${round.role}`}>
                        <div className="message-content">{round.content}</div>
                      </div>
                    ))}
                    {isDiscussing && (
                      <div className="discussion-message assistant">
                        <div className="message-content typing">
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                        </div>
                      </div>
                    )}
                    <div ref={discussEndRef} />
                  </div>
                  <div className="discussion-input">
                    <input
                      type="text"
                      placeholder="我想表达..."
                      value={discussInput}
                      onChange={e => setDiscussInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                    />
                    <button
                      className="discuss-send"
                      onClick={handleDiscussSubmit}
                      disabled={!discussInput.trim() || isDiscussing}
                    >
                      <Send size={16} />
                    </button>
                  </div>
                  {discussionRounds.length >= 2 && (
                    <button className="generate-replies-btn" onClick={generateReplies}>
                      <Sparkles size={14} />
                      <span>生成回复建议</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Reply Suggestions */}
            {replySuggestions.length > 0 && (
              <div className="reply-suggestions">
                <h3>回复建议</h3>
                <div className="suggestions-grid">
                  {replySuggestions.map((suggestion, i) => (
                    <div key={i} className={`suggestion-card style-${suggestion.style}`}>
                      <div className="suggestion-header">
                        <span className={`style-badge ${suggestion.style}`}>
                          {suggestion.style === 'safe' ? '稳妥' : suggestion.style === 'warm' ? '温暖' : '坚定'}
                        </span>
                        <span className="confidence">{Math.round(suggestion.confidence * 100)}%</span>
                      </div>
                      {editingSuggestion === i ? (
                        <textarea
                          className="suggestion-edit"
                          value={editedContent}
                          onChange={e => setEditedContent(e.target.value)}
                          autoFocus
                          onBlur={() => setEditingSuggestion(null)}
                        />
                      ) : (
                        <p className="suggestion-content">{suggestion.content}</p>
                      )}
                      <p className="suggestion-reason">{suggestion.reason}</p>
                      <div className="suggestion-actions">
                        <button
                          className="btn-apply"
                          onClick={() => handleApplySuggestion(editingSuggestion === i ? editedContent : suggestion.content)}
                        >
                          <Send size={12} /> 应用
                        </button>
                        <button
                          className="btn-edit"
                          onClick={() => handleEditSuggestion(i, suggestion.content)}
                        >
                          <Edit2 size={12} /> 编辑
                        </button>
                        <button
                          className="btn-copy"
                          onClick={() => {
                            navigator.clipboard.writeText(suggestion.content)
                            if (selectedContact && suggestion.style) {
                              window.electronAPI.intel.recordSuggestionUsage(selectedContact, suggestion.style, 'copy')
                            }
                          }}
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Debug Link */}
            <div className="debug-link">
              <button onClick={() => navigate('/coach-log')}>
                <Bug size={14} /> 查看AI上下文
              </button>
            </div>
          </div>
        )}

        {/* Empty state when no contact selected and no briefing */}
        {!selectedContact && !briefing && (
          <div className="assistant-empty">
            <Sparkles size={32} />
            <p>选择一个联系人开始智能沟通</p>
          </div>
        )}
      </div>

      {/* Right Column - Context Panel */}
      <div className="assistant-right-col">
        {selectedContact && contextData && (
          <div className="context-panel">
            <h3>关系上下文</h3>
            <div className="context-section">
              <h4>关系类型</h4>
              <p>{(contextData as Record<string, string>).relationship}</p>
            </div>
            <div className="context-section">
              <h4>沟通风格</h4>
              <p>{(contextData as Record<string, string>).communicationStyle}</p>
            </div>
            <div className="context-section">
              <h4>最近联系</h4>
              <p>{(contextData as Record<string, number>).lastContactDays} 天前</p>
            </div>

            <h3 className="personality-title">性格画像</h3>
            <div className="context-section">
              <p>{(contextData as Record<string, string>).personality}</p>
            </div>

            <h3 className="topics-title">近期话题</h3>
            <div className="topic-tags">
              {((contextData as Record<string, string[]>).recentTopics || []).map((topic, i) => (
                <span key={i} className="topic-tag">{topic}</span>
              ))}
            </div>
          </div>
        )}

        {!selectedContact && (
          <div className="context-panel context-empty">
            <Eye size={24} />
            <p>选择联系人查看关系洞察</p>
          </div>
        )}
      </div>
    </div>
  )
}

interface ContactItemProps {
  contact: ContactWithStatus
  isSelected: boolean
  onSelect: () => void
  onStar: () => void
  onIgnore: () => void
}

function ContactItem({ contact, isSelected, onSelect, onStar, onIgnore }: ContactItemProps) {
  const [showMenu, setShowMenu] = useState(false)

  return (
    <div
      className={`contact-item ${isSelected ? 'selected' : ''} ${contact.ignored ? 'ignored' : ''}`}
      onClick={onSelect}
      onContextMenu={e => {
        e.preventDefault()
        setShowMenu(!showMenu)
      }}
    >
      <div className="contact-avatar-sm">{contact.name[0]}</div>
      <div className="contact-info">
        <div className="contact-name">
          {contact.name}
          {contact.starred && <Star size={12} className="star-icon" />}
        </div>
        <div className="contact-last-msg">{contact.lastMessage}</div>
      </div>
      {contact.unread > 0 && (
        <span className="unread-badge">{contact.unread}</span>
      )}
      {showMenu && (
        <div className="contact-menu" onMouseLeave={() => setShowMenu(false)}>
          <button onClick={e => { e.stopPropagation(); onStar(); setShowMenu(false) }}>
            {contact.starred ? '取消星标' : '星标'}
          </button>
          <button onClick={e => { e.stopPropagation(); onIgnore(); setShowMenu(false) }}>
            {contact.ignored ? '取消忽略' : '忽略'}
          </button>
        </div>
      )}
    </div>
  )
}

export default AssistantPage
