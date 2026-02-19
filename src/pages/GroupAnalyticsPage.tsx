import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { Users, BarChart3, Clock, Image, Loader2, RefreshCw, User, Medal, Search, X, ChevronLeft, Copy, Check, Download } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import ReactECharts from 'echarts-for-react'
import DateRangePicker from '../components/DateRangePicker'
import './GroupAnalyticsPage.scss'

interface GroupChatInfo {
  username: string
  displayName: string
  memberCount: number
  avatarUrl?: string
}

interface GroupMember {
  username: string
  displayName: string
  avatarUrl?: string
  nickname?: string
  alias?: string
  remark?: string
  groupNickname?: string
}

interface GroupMessageRank {
  member: GroupMember
  messageCount: number
}

type AnalysisFunction = 'members' | 'ranking' | 'activeHours' | 'mediaStats'

function GroupAnalyticsPage() {
  const location = useLocation()
  const [groups, setGroups] = useState<GroupChatInfo[]>([])
  const [filteredGroups, setFilteredGroups] = useState<GroupChatInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedGroup, setSelectedGroup] = useState<GroupChatInfo | null>(null)
  const [selectedFunction, setSelectedFunction] = useState<AnalysisFunction | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // 功能数据
  const [members, setMembers] = useState<GroupMember[]>([])
  const [rankings, setRankings] = useState<GroupMessageRank[]>([])
  const [activeHours, setActiveHours] = useState<Record<number, number>>({})
  const [mediaStats, setMediaStats] = useState<{ typeCounts: Array<{ type: number; name: string; count: number }>; total: number } | null>(null)
  const [functionLoading, setFunctionLoading] = useState(false)
  const [isExportingMembers, setIsExportingMembers] = useState(false)
  const [isExportingMemberMessages, setIsExportingMemberMessages] = useState(false)

  // 成员详情弹框
  const [selectedMember, setSelectedMember] = useState<GroupMember | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  // 时间范围
  const [startDate, setStartDate] = useState<string>('')
  const [endDate, setEndDate] = useState<string>('')
  const [dateRangeReady, setDateRangeReady] = useState(false)

  // 拖动调整宽度
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const preselectAppliedRef = useRef(false)

  const preselectGroupIds = useMemo(() => {
    const state = location.state as { preselectGroupIds?: unknown; preselectGroupId?: unknown } | null
    const rawList = Array.isArray(state?.preselectGroupIds)
      ? state.preselectGroupIds
      : (typeof state?.preselectGroupId === 'string' ? [state.preselectGroupId] : [])

    return rawList
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  }, [location.state])

  useEffect(() => {
    loadGroups()
  }, [])

  useEffect(() => {
    preselectAppliedRef.current = false
  }, [location.key, preselectGroupIds])

  useEffect(() => {
    if (searchQuery) {
      setFilteredGroups(groups.filter(g => g.displayName.toLowerCase().includes(searchQuery.toLowerCase())))
    } else {
      setFilteredGroups(groups)
    }
  }, [searchQuery, groups])

  useEffect(() => {
    if (preselectAppliedRef.current) return
    if (groups.length === 0 || preselectGroupIds.length === 0) return

    const matchedGroup = groups.find(group => preselectGroupIds.includes(group.username))
    preselectAppliedRef.current = true

    if (matchedGroup) {
      setSelectedGroup(matchedGroup)
      setSelectedFunction(null)
      setSearchQuery('')
    }
  }, [groups, preselectGroupIds])

  // 拖动调整宽度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !containerRef.current) return
      const containerRect = containerRef.current.getBoundingClientRect()
      const newWidth = e.clientX - containerRect.left
      setSidebarWidth(Math.max(250, Math.min(450, newWidth)))
    }
    const handleMouseUp = () => setIsResizing(false)
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // 日期范围变化时自动刷新
  useEffect(() => {
    if (dateRangeReady && selectedGroup && selectedFunction && selectedFunction !== 'members') {
      setDateRangeReady(false)
      loadFunctionData(selectedFunction)
    }
  }, [dateRangeReady])

  const loadGroups = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.groupAnalytics.getGroupChats()
      if (result.success && result.data) {
        setGroups(result.data)
        setFilteredGroups(result.data)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    const handleChange = () => {
      setGroups([])
      setFilteredGroups([])
      setSelectedGroup(null)
      setSelectedFunction(null)
      setMembers([])
      setRankings([])
      setActiveHours({})
      setMediaStats(null)
      void loadGroups()
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [loadGroups])

  const handleGroupSelect = (group: GroupChatInfo) => {
    if (selectedGroup?.username !== group.username) {
      setSelectedGroup(group)
      setSelectedFunction(null)
    }
  }


  const handleFunctionSelect = async (func: AnalysisFunction) => {
    if (!selectedGroup) return
    setSelectedFunction(func)
    await loadFunctionData(func)
  }

  const loadFunctionData = async (func: AnalysisFunction) => {
    if (!selectedGroup) return
    setFunctionLoading(true)

    // 计算时间戳
    const startTime = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined
    const endTime = endDate ? Math.floor(new Date(endDate + 'T23:59:59').getTime() / 1000) : undefined

    try {
      switch (func) {
        case 'members': {
          const result = await window.electronAPI.groupAnalytics.getGroupMembers(selectedGroup.username)
          if (result.success && result.data) setMembers(result.data)
          break
        }
        case 'ranking': {
          const result = await window.electronAPI.groupAnalytics.getGroupMessageRanking(selectedGroup.username, 20, startTime, endTime)
          if (result.success && result.data) setRankings(result.data)
          break
        }
        case 'activeHours': {
          const result = await window.electronAPI.groupAnalytics.getGroupActiveHours(selectedGroup.username, startTime, endTime)
          if (result.success && result.data) setActiveHours(result.data.hourlyDistribution)
          break
        }
        case 'mediaStats': {
          const result = await window.electronAPI.groupAnalytics.getGroupMediaStats(selectedGroup.username, startTime, endTime)
          if (result.success && result.data) setMediaStats(result.data)
          break
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      setFunctionLoading(false)
    }
  }

  const formatNumber = (num: number) => {
    if (num >= 10000) return (num / 10000).toFixed(1) + '万'
    return num.toLocaleString()
  }

  const sanitizeFileName = (name: string) => {
    return name.replace(/[<>:"/\\|?*]+/g, '_').trim()
  }

  const getHourlyOption = () => {
    const hours = Array.from({ length: 24 }, (_, i) => i)
    const data = hours.map(h => activeHours[h] || 0)
    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: hours.map(h => `${h}时`) },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data, itemStyle: { color: '#07c160', borderRadius: [4, 4, 0, 0] } }]
    }
  }

  const getMediaOption = () => {
    if (!mediaStats || mediaStats.typeCounts.length === 0) return {}

    // 定义颜色映射
    const colorMap: Record<number, string> = {
      1: '#3b82f6',   // 文本 - 蓝色
      3: '#22c55e',   // 图片 - 绿色
      34: '#f97316',  // 语音 - 橙色
      43: '#a855f7',  // 视频 - 紫色
      47: '#ec4899',  // 表情包 - 粉色
      49: '#14b8a6',  // 链接/文件 - 青色
      [-1]: '#6b7280', // 其他 - 灰色
    }

    const data = mediaStats.typeCounts.map(item => ({
      name: item.name,
      value: item.count,
      itemStyle: { color: colorMap[item.type] || '#6b7280' }
    }))

    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['50%', '50%'],
        itemStyle: { borderRadius: 8, borderColor: 'rgba(255,255,255,0.1)', borderWidth: 2 },
        label: {
          show: true,
          formatter: (params: { name: string; percent: number }) => {
            // 只显示占比大于3%的标签
            return params.percent > 3 ? `${params.name}\n${params.percent.toFixed(1)}%` : ''
          },
          color: '#fff'
        },
        labelLine: {
          show: true,
          length: 10,
          length2: 10
        },
        data
      }]
    }
  }

  const handleRefresh = () => {
    if (selectedFunction) {
      loadFunctionData(selectedFunction)
    }
  }

  const handleDateRangeComplete = () => {
    setDateRangeReady(true)
  }

  const handleMemberClick = (member: GroupMember) => {
    setSelectedMember(member)
    setCopiedField(null)
  }

  const handleExportMembers = async () => {
    if (!selectedGroup || isExportingMembers) return
    setIsExportingMembers(true)
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      const baseName = sanitizeFileName(`${selectedGroup.displayName || selectedGroup.username}_群成员列表`)
      const separator = downloadsPath && downloadsPath.includes('\\') ? '\\' : '/'
      const defaultPath = downloadsPath ? `${downloadsPath}${separator}${baseName}.xlsx` : `${baseName}.xlsx`
      const saveResult = await window.electronAPI.dialog.saveFile({
        title: '导出群成员列表',
        defaultPath,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      })
      if (!saveResult || saveResult.canceled || !saveResult.filePath) return

      const result = await window.electronAPI.groupAnalytics.exportGroupMembers(selectedGroup.username, saveResult.filePath)
      if (result.success) {
        alert(`导出成功，共 ${result.count ?? members.length} 人`)
      } else {
        alert(`导出失败：${result.error || '未知错误'}`)
      }
    } catch (e) {
      console.error('导出群成员失败:', e)
      alert(`导出失败：${String(e)}`)
    } finally {
      setIsExportingMembers(false)
    }
  }

  const handleExportMemberMessages = async (member: GroupMember) => {
    if (!selectedGroup || !member || isExportingMemberMessages) return
    setIsExportingMemberMessages(true)
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      const memberName = member.displayName || member.username
      const baseName = sanitizeFileName(`${selectedGroup.displayName || selectedGroup.username}_${memberName}_消息记录`)
      const separator = downloadsPath && downloadsPath.includes('\\') ? '\\' : '/'
      const defaultPath = downloadsPath ? `${downloadsPath}${separator}${baseName}.xlsx` : `${baseName}.xlsx`
      const saveResult = await window.electronAPI.dialog.saveFile({
        title: `导出 ${memberName} 的群聊消息`,
        defaultPath,
        filters: [
          { name: 'Excel', extensions: ['xlsx'] },
          { name: 'CSV', extensions: ['csv'] }
        ]
      })
      if (!saveResult || saveResult.canceled || !saveResult.filePath) return

      const result = await window.electronAPI.groupAnalytics.exportGroupMemberMessages(
        selectedGroup.username,
        member.username,
        saveResult.filePath
      )
      if (result.success) {
        alert(`导出成功，共 ${result.count ?? 0} 条消息`)
      } else {
        alert(`导出失败：${result.error || '未知错误'}`)
      }
    } catch (e) {
      console.error('导出成员消息失败:', e)
      alert(`导出失败：${String(e)}`)
    } finally {
      setIsExportingMemberMessages(false)
    }
  }

  const handleCopy = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch (e) {
      console.error('复制失败:', e)
    }
  }

  const renderMemberModal = () => {
    if (!selectedMember) return null
    const nickname = (selectedMember.nickname || '').trim()
    const alias = (selectedMember.alias || '').trim()
    const remark = (selectedMember.remark || '').trim()
    const groupNickname = (selectedMember.groupNickname || '').trim()

    return (
      <div className="member-modal-overlay" onClick={() => setSelectedMember(null)}>
        <div className="member-modal" onClick={e => e.stopPropagation()}>
          <button className="modal-close" onClick={() => setSelectedMember(null)}>
            <X size={20} />
          </button>
          <div className="modal-content">
            <div className="member-avatar large">
              <Avatar src={selectedMember.avatarUrl} name={selectedMember.displayName} size={96} />
            </div>
            <h3 className="member-display-name">{selectedMember.displayName}</h3>
            <div className="member-action-row">
              <button
                className="export-member-btn"
                onClick={() => handleExportMemberMessages(selectedMember)}
                disabled={isExportingMemberMessages}
              >
                {isExportingMemberMessages ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
                <span>{isExportingMemberMessages ? '导出中...' : '导出该成员全部消息'}</span>
              </button>
            </div>
            <div className="member-details">
              <div className="detail-row">
                <span className="detail-label">微信ID</span>
                <span className="detail-value">{selectedMember.username}</span>
                <button className="copy-btn" onClick={() => handleCopy(selectedMember.username, 'username')}>
                  {copiedField === 'username' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <div className="detail-row">
                <span className="detail-label">昵称</span>
                <span className="detail-value">{nickname || '未设置'}</span>
                {nickname && (
                  <button className="copy-btn" onClick={() => handleCopy(nickname, 'nickname')}>
                    {copiedField === 'nickname' ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                )}
              </div>
              {alias && (
                <div className="detail-row">
                  <span className="detail-label">微信号</span>
                  <span className="detail-value">{alias}</span>
                  <button className="copy-btn" onClick={() => handleCopy(alias, 'alias')}>
                    {copiedField === 'alias' ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              )}
              {groupNickname && (
                <div className="detail-row">
                  <span className="detail-label">群昵称</span>
                  <span className="detail-value">{groupNickname}</span>
                  <button className="copy-btn" onClick={() => handleCopy(groupNickname, 'groupNickname')}>
                    {copiedField === 'groupNickname' ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              )}
              {remark && (
                <div className="detail-row">
                  <span className="detail-label">备注</span>
                  <span className="detail-value">{remark}</span>
                  <button className="copy-btn" onClick={() => handleCopy(remark, 'remark')}>
                    {copiedField === 'remark' ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderGroupList = () => (
    <div className="group-sidebar" style={{ width: sidebarWidth }}>
      <div className="sidebar-header">
        <div className="search-row">
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="搜索群聊..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="close-search" onClick={() => setSearchQuery('')}>
                <X size={12} />
              </button>
            )}
          </div>
          <button className="refresh-btn" onClick={loadGroups} disabled={isLoading}>
            <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="group-list">
        {isLoading ? (
          <div className="loading-groups">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="skeleton-item">
                <div className="skeleton-avatar" />
                <div className="skeleton-content">
                  <div className="skeleton-line" />
                  <div className="skeleton-line" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="empty-groups">
            <Users size={48} />
            <p>{searchQuery ? '未找到匹配的群聊' : '暂无群聊数据'}</p>
          </div>
        ) : (
          filteredGroups.map(group => (
            <div
              key={group.username}
              className={`group-item ${selectedGroup?.username === group.username ? 'active' : ''}`}
              onClick={() => handleGroupSelect(group)}
            >
              <div className="group-avatar">
                <Avatar src={group.avatarUrl} name={group.displayName} size={44} />
              </div>
              <div className="group-info">
                <span className="group-name">{group.displayName}</span>
                <span className="group-members">{group.memberCount} 位成员</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )


  const renderFunctionMenu = () => (
    <div className="function-menu">
      <div className="selected-group-info">
        <div className="group-avatar large">
          <Avatar src={selectedGroup?.avatarUrl} name={selectedGroup?.displayName} size={80} />
        </div>
        <h2>{selectedGroup?.displayName}</h2>
        <p>{selectedGroup?.memberCount} 位成员</p>
      </div>
      <div className="function-grid">
        <div className="function-card" onClick={() => handleFunctionSelect('members')}>
          <Users size={32} />
          <span>群成员查看</span>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('ranking')}>
          <BarChart3 size={32} />
          <span>群聊发言排行</span>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('activeHours')}>
          <Clock size={32} />
          <span>群聊活跃时段</span>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('mediaStats')}>
          <Image size={32} />
          <span>媒体内容统计</span>
        </div>
      </div>
    </div>
  )

  const renderFunctionContent = () => {
    const getFunctionTitle = () => {
      switch (selectedFunction) {
        case 'members': return '群成员查看'
        case 'ranking': return '群聊发言排行'
        case 'activeHours': return '群聊活跃时段'
        case 'mediaStats': return '媒体内容统计'
        default: return ''
      }
    }

    const showDateRange = selectedFunction !== 'members'

    return (
      <div className="function-content">
        <div className="content-header">
          <button className="back-btn" onClick={() => setSelectedFunction(null)}>
            <ChevronLeft size={20} />
          </button>
          <div className="header-info">
            <h3>{getFunctionTitle()}</h3>
            <span className="header-subtitle">{selectedGroup?.displayName}</span>
          </div>
          {showDateRange && (
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={setStartDate}
              onEndDateChange={setEndDate}
              onRangeComplete={handleDateRangeComplete}
            />
          )}
          {selectedFunction === 'members' && (
            <button className="export-btn" onClick={handleExportMembers} disabled={functionLoading || isExportingMembers}>
              {isExportingMembers ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
              <span>导出成员</span>
            </button>
          )}
          <button className="refresh-btn" onClick={handleRefresh} disabled={functionLoading}>
            <RefreshCw size={16} className={functionLoading ? 'spin' : ''} />
          </button>
        </div>
        <div className="content-body">
          {functionLoading ? (
            <div className="content-loading"><Loader2 size={32} className="spin" /></div>
          ) : (
            <>
              {selectedFunction === 'members' && (
                <div className="members-grid">
                  {members.map(member => (
                    <div key={member.username} className="member-card" onClick={() => handleMemberClick(member)}>
                      <div className="member-avatar">
                        <Avatar src={member.avatarUrl} name={member.displayName} size={48} />
                      </div>
                      <span className="member-name">{member.displayName}</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedFunction === 'ranking' && (
                <div className="rankings-list">
                  {rankings.map((item, index) => (
                    <div key={item.member.username} className="ranking-item">
                      <span className={`rank ${index < 3 ? 'top' : ''}`}>{index + 1}</span>
                      <div className="contact-avatar">
                        <Avatar src={item.member.avatarUrl} name={item.member.displayName} size={40} />
                        {index < 3 && <div className={`medal medal-${index + 1}`}><Medal size={10} /></div>}
                      </div>
                      <div className="contact-info">
                        <span className="contact-name">{item.member.displayName}</span>
                      </div>
                      <span className="message-count">{formatNumber(item.messageCount)} 条</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedFunction === 'activeHours' && (
                <div className="chart-container">
                  <ReactECharts option={getHourlyOption()} style={{ height: '100%', minHeight: 300 }} />
                </div>
              )}
              {selectedFunction === 'mediaStats' && mediaStats && (
                <div className="media-stats">
                  <div className="media-layout">
                    <div className="chart-container">
                      <ReactECharts option={getMediaOption()} style={{ height: '100%', minHeight: 300 }} />
                    </div>
                    <div className="media-legend">
                      {mediaStats.typeCounts.map(item => {
                        const colorMap: Record<number, string> = {
                          1: '#3b82f6', 3: '#22c55e', 34: '#f97316',
                          43: '#a855f7', 47: '#ec4899', 49: '#14b8a6', [-1]: '#6b7280'
                        }
                        const percentage = mediaStats.total > 0 ? ((item.count / mediaStats.total) * 100).toFixed(1) : '0'
                        return (
                          <div key={item.type} className="legend-item">
                            <span className="legend-color" style={{ backgroundColor: colorMap[item.type] || '#6b7280' }} />
                            <span className="legend-name">{item.name}</span>
                            <span className="legend-count">{formatNumber(item.count)} 条</span>
                            <span className="legend-percent">({percentage}%)</span>
                          </div>
                        )
                      })}
                      <div className="legend-total">
                        <span>总计</span>
                        <span>{formatNumber(mediaStats.total)} 条</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }


  const renderDetailPanel = () => {
    if (!selectedGroup) {
      return (
        <div className="placeholder">
          <Users size={64} />
          <p>请从左侧选择一个群聊进行分析</p>
        </div>
      )
    }
    if (!selectedFunction) {
      return renderFunctionMenu()
    }
    return renderFunctionContent()
  }

  return (
    <div className={`group-analytics-page ${isResizing ? 'resizing' : ''}`} ref={containerRef}>
      {renderGroupList()}
      <div className="resize-handle" onMouseDown={() => setIsResizing(true)} />
      <div className="detail-area">
        {renderDetailPanel()}
      </div>
      {renderMemberModal()}
    </div>
  )
}

export default GroupAnalyticsPage
