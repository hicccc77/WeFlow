import React from 'react'
import { Search, User, X, Loader2, CheckSquare, Square, Download } from 'lucide-react'
import { Avatar } from '../Avatar'

interface Contact {
    username: string
    displayName: string
    avatarUrl?: string
    postCount?: number
    postCountStatus?: 'idle' | 'loading' | 'ready'
}

interface ContactsCountProgress {
    resolved: number
    total: number
    running: boolean
}

interface SnsFilterPanelProps {
    searchKeyword: string
    setSearchKeyword: (val: string) => void
    totalFriendsLabel?: string
    contacts: Contact[]
    contactSearch: string
    setContactSearch: (val: string) => void
    loading?: boolean
    contactsCountProgress?: ContactsCountProgress
    selectedContactUsernames: string[]
    activeContactUsername?: string
    onOpenContactTimeline: (contact: Contact) => void
    onToggleContactSelected: (contact: Contact) => void
    onToggleFilteredContacts: (usernames: string[], shouldSelect: boolean) => void
    onClearSelectedContacts: () => void
    onExportSelectedContacts: () => void
}

export const SnsFilterPanel: React.FC<SnsFilterPanelProps> = ({
    searchKeyword,
    setSearchKeyword,
    totalFriendsLabel,
    contacts,
    contactSearch,
    setContactSearch,
    loading,
    contactsCountProgress,
    selectedContactUsernames,
    activeContactUsername,
    onOpenContactTimeline,
    onToggleContactSelected,
    onToggleFilteredContacts,
    onClearSelectedContacts,
    onExportSelectedContacts
}) => {
    const filteredContacts = contacts.filter(c =>
        (c.displayName || '').toLowerCase().includes(contactSearch.toLowerCase()) ||
        c.username.toLowerCase().includes(contactSearch.toLowerCase())
    )
    const selectedContactLookup = React.useMemo(
        () => new Set(selectedContactUsernames),
        [selectedContactUsernames]
    )
    const filteredContactUsernames = React.useMemo(
        () => filteredContacts.map((contact) => contact.username),
        [filteredContacts]
    )
    const selectedFilteredCount = React.useMemo(
        () => filteredContactUsernames.filter((username) => selectedContactLookup.has(username)).length,
        [filteredContactUsernames, selectedContactLookup]
    )
    const hasFilteredContacts = filteredContactUsernames.length > 0
    const allFilteredSelected = hasFilteredContacts && selectedFilteredCount === filteredContactUsernames.length

    const clearFilters = () => {
        setSearchKeyword('')
        setContactSearch('')
    }

    const getEmptyStateText = () => {
        if (loading && contacts.length === 0) {
            return '正在加载联系人...'
        }
        if (contacts.length === 0) {
            return '暂无好友或曾经的好友'
        }
        return '没有找到联系人'
    }

    return (
        <aside className="sns-filter-panel">
            <div className="filter-header">
                <h3>筛选条件</h3>
                {(searchKeyword || contactSearch) && (
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
                {/* Contact Widget */}
                <div className="filter-widget contact-widget">
                    <div className="widget-header">
                        <User size={14} />
                        <span>联系人</span>
                        {totalFriendsLabel && (
                            <span className="widget-header-summary">{totalFriendsLabel}</span>
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
                            <X size={14} className="clear-icon" onClick={() => setContactSearch('')} />
                        )}
                    </div>

                    <div className="contact-selection-toolbar">
                        <span className="contact-selection-summary">
                            当前 {filteredContactUsernames.length} 人，已选 {selectedFilteredCount} 人
                        </span>
                        <button
                            type="button"
                            className={`contact-selection-toggle${allFilteredSelected ? ' active' : ''}`}
                            onClick={() => onToggleFilteredContacts(filteredContactUsernames, !allFilteredSelected)}
                            disabled={!hasFilteredContacts}
                        >
                            {allFilteredSelected ? '取消全选' : '全选'}
                        </button>
                    </div>

                    {contactsCountProgress && contactsCountProgress.total > 0 && (
                        <div className="contact-count-progress">
                            {contactsCountProgress.running
                                ? `朋友圈条数统计中 ${contactsCountProgress.resolved}/${contactsCountProgress.total}`
                                : `朋友圈条数已统计 ${contactsCountProgress.total}/${contactsCountProgress.total}`}
                        </div>
                    )}

                    <div className="contact-interaction-hint">
                        点左侧可多选下载，点右侧可查看单人详情
                    </div>

                    <div className="contact-list-scroll">
                        {filteredContacts.map(contact => {
                            const isPostCountReady = contact.postCountStatus === 'ready'
                            const isSelected = selectedContactLookup.has(contact.username)
                            const isActive = activeContactUsername === contact.username
                            return (
                                <div
                                    key={contact.username}
                                    className={`contact-row${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                                >
                                    <button
                                        type="button"
                                        className={`contact-select-btn${isSelected ? ' checked' : ''}`}
                                        onClick={() => onToggleContactSelected(contact)}
                                        title={isSelected ? `取消选择 ${contact.displayName}` : `选择 ${contact.displayName}`}
                                        aria-pressed={isSelected}
                                    >
                                        {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                                    </button>
                                    <button
                                        type="button"
                                        className="contact-main-btn"
                                        onClick={() => onOpenContactTimeline(contact)}
                                        title={`查看 ${contact.displayName} 的朋友圈`}
                                    >
                                        <Avatar src={contact.avatarUrl} name={contact.displayName} size={36} shape="rounded" />
                                        <div className="contact-meta">
                                            <span className="contact-name">{contact.displayName}</span>
                                        </div>
                                        <div className="contact-post-count-wrap">
                                            {isPostCountReady ? (
                                                <span className="contact-post-count">{Math.max(0, Math.floor(Number(contact.postCount || 0)))}条</span>
                                            ) : (
                                                <span className="contact-post-count-loading" title="统计中">
                                                    <Loader2 size={13} className="spinning" />
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                </div>
                            )
                        })}
                        {filteredContacts.length === 0 && (
                            <div className="empty-state">{getEmptyStateText()}</div>
                        )}
                    </div>

                    {selectedContactUsernames.length > 0 && (
                        <div className="contact-batch-bar">
                            <span className="contact-batch-summary">已选 {selectedContactUsernames.length} 人</span>
                            <button type="button" className="contact-batch-btn" onClick={onClearSelectedContacts}>
                                清空
                            </button>
                            <button type="button" className="contact-batch-btn primary" onClick={onExportSelectedContacts}>
                                <Download size={14} />
                                <span>下载所选</span>
                            </button>
                        </div>
                    )}
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
