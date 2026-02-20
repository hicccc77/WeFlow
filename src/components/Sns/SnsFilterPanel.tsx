import React, { useState } from 'react'
import { Search, Calendar, User, X, Filter, Check } from 'lucide-react'
import { Avatar } from '../Avatar'
// import JumpToDateDialog from '../JumpToDateDialog' // Assuming this is imported from parent or moved

interface Contact {
    username: string
    displayName: string
    avatarUrl?: string
}

interface SnsFilterPanelProps {
    searchKeyword: string
    setSearchKeyword: (val: string) => void
    jumpTargetDate?: Date
    setJumpTargetDate: (date?: Date) => void
    onOpenJumpDialog: () => void
    selectedUsernames: string[]
    setSelectedUsernames: (val: string[]) => void
    contacts: Contact[]
    contactSearch: string
    setContactSearch: (val: string) => void
    loading?: boolean
}

export const SnsFilterPanel: React.FC<SnsFilterPanelProps> = ({
    searchKeyword,
    setSearchKeyword,
    jumpTargetDate,
    setJumpTargetDate,
    onOpenJumpDialog,
    selectedUsernames,
    setSelectedUsernames,
    contacts,
    contactSearch,
    setContactSearch,
    loading
}) => {

    const filteredContacts = contacts.filter(c =>
        c.displayName.toLowerCase().includes(contactSearch.toLowerCase()) ||
        c.username.toLowerCase().includes(contactSearch.toLowerCase())
    )

    const toggleUserSelection = (username: string) => {
        if (selectedUsernames.includes(username)) {
            setSelectedUsernames(selectedUsernames.filter(u => u !== username))
        } else {
            setJumpTargetDate(undefined) // Reset date jump when selecting user
            setSelectedUsernames([...selectedUsernames, username])
        }
    }

    const clearFilters = () => {
        setSearchKeyword('')
        setSelectedUsernames([])
        setJumpTargetDate(undefined)
    }

    return (
        <aside className="sns-filter-panel">
            <div className="filter-header">
                <h3>筛选条件</h3>
                {(searchKeyword || jumpTargetDate || selectedUsernames.length > 0) && (
                    <button className="reset-all-btn" onClick={clearFilters} title="重置所有筛选">
                        <RefreshCw size={14} />
                    </button>
                )}
            </div>

            <div className="filter-widgets">
                {/* Search Widget */}
                <div className="filter-widget search-widget">
                    <div className="widget-header">
                        <Search size={14} />
                        <span>关键词搜索</span>
                    </div>
                    <div className="input-group">
                        <input
                            type="text"
                            placeholder="搜索动态内容..."
                            value={searchKeyword}
                            onChange={e => setSearchKeyword(e.target.value)}
                        />
                        {searchKeyword && (
                            <button className="clear-input-btn" onClick={() => setSearchKeyword('')}>
                                <X size={14} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Date Widget */}
                <div className="filter-widget date-widget">
                    <div className="widget-header">
                        <Calendar size={14} />
                        <span>时间跳转</span>
                    </div>
                    <button
                        className={`date-picker-trigger ${jumpTargetDate ? 'active' : ''}`}
                        onClick={onOpenJumpDialog}
                    >
                        <span className="date-text">
                            {jumpTargetDate
                                ? jumpTargetDate.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
                                : '选择日期...'}
                        </span>
                        {jumpTargetDate && (
                            <div
                                className="clear-date-btn"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    setJumpTargetDate(undefined)
                                }}
                            >
                                <X size={12} />
                            </div>
                        )}
                    </button>
                </div>

                {/* Contact Widget */}
                <div className="filter-widget contact-widget">
                    <div className="widget-header">
                        <User size={14} />
                        <span>联系人</span>
                        {selectedUsernames.length > 0 && (
                            <span className="badge">{selectedUsernames.length}</span>
                        )}
                    </div>

                    <div className="contact-search-bar">
                        <input
                            type="text"
                            placeholder="查找好友..."
                            value={contactSearch}
                            onChange={e => setContactSearch(e.target.value)}
                        />
                        <Search size={14} className="search-icon" />
                        {contactSearch && (
                            <X size={14} className="clear-icon" onClick={() => setContactSearch('')} style={{ right: 8, top: 8, position: 'absolute', cursor: 'pointer', color: 'var(--text-tertiary)' }} />
                        )}
                    </div>

                    <div className="contact-list-scroll">
                        {filteredContacts.map(contact => (
                            <div
                                key={contact.username}
                                className={`contact-row ${selectedUsernames.includes(contact.username) ? 'selected' : ''}`}
                                onClick={() => toggleUserSelection(contact.username)}
                            >
                                <Avatar src={contact.avatarUrl} name={contact.displayName} size={36} shape="rounded" />
                                <span className="contact-name">{contact.displayName}</span>
                            </div>
                        ))}
                        {filteredContacts.length === 0 && (
                            <div className="empty-state">没有找到联系人</div>
                        )}
                    </div>
                </div>
            </div>
        </aside>
    )
}

function RefreshCw({ size, className }: { size?: number, className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size || 24}
            height={size || 24}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
    )
}
