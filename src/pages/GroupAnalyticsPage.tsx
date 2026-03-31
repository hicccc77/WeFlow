import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { Users, BarChart3, Clock, Image, Loader2, RefreshCw, Medal, Search, X, ChevronLeft, Copy, Check, Download, ChevronDown, MessageSquare, Calendar, PieChart, Hash, Smile } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import ReactECharts from 'echarts-for-react'
import DateRangePicker from '../components/DateRangePicker'
import ChatAnalysisHeader from '../components/ChatAnalysisHeader'
import * as configService from '../services/config'
import type { Message } from '../types/models'
import {
  finishBackgroundTask,
  isBackgroundTaskCancelRequested,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
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

type AnalysisFunction = 'members' | 'memberMessages' | 'memberAnalytics' | 'ranking' | 'activeHours' | 'mediaStats'
type MemberExportFormat = 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'txt' | 'excel' | 'weclone'

interface MemberMessageExportOptions {
  format: MemberExportFormat
  exportAvatars: boolean
  exportMedia: boolean
  exportImages: boolean
  exportVoices: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoiceAsText: boolean
  displayNamePreference: 'group-nickname' | 'remark' | 'nickname'
}

interface MemberExportFormatOption {
  value: MemberExportFormat
  label: string
  desc: string
}

interface GroupMemberMessagesPage {
  messages: Message[]
  hasMore: boolean
  nextCursor: number
}

const MEMBER_MESSAGE_PAGE_SIZE = 40

const filterMembersByKeyword = (members: GroupMember[], keyword: string) => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  if (!normalizedKeyword) return members
  return members.filter(member => {
    const fields = [
      member.username,
      member.displayName,
      member.nickname,
      member.remark,
      member.alias,
      member.groupNickname
    ]
    return fields.some(field => String(field || '').toLowerCase().includes(normalizedKeyword))
  })
}

const formatMemberMessageTime = (createTime: number) => {
  if (!createTime) return '-'
  return new Date(createTime * 1000).toLocaleString('zh-CN', { hour12: false })
}

const getMemberMessageTypeLabel = (message: Message) => {
  switch (message.localType) {
    case 1:
      return '文本'
    case 3:
      return '图片'
    case 34:
      return '语音'
    case 42:
      return '名片'
    case 43:
      return '视频'
    case 47:
      return '表情'
    case 48:
      return '位置'
    case 49:
      return message.fileName ? '文件' : '链接'
    case 50:
      return '通话'
    case 10000:
    case 10002:
      return '系统'
    default:
      return `类型 ${message.localType}`
  }
}

const getMemberMessagePreview = (message: Message) => {
  const text = (message.parsedContent || message.content || message.rawContent || '').trim()
  switch (message.localType) {
    case 1:
    case 10000:
    case 10002:
      return text || '[空文本]'
    case 3:
      return text || '[图片]'
    case 34:
      return message.voiceDurationSeconds ? `[语音] ${message.voiceDurationSeconds} 秒` : '[语音]'
    case 42:
      return `[名片] ${message.cardNickname || message.cardUsername || text || '联系人名片'}`
    case 43:
      return text || '[视频]'
    case 47:
      return text || '[表情]'
    case 48:
      return `[位置] ${message.locationPoiname || message.locationLabel || text || '位置消息'}`
    case 49:
      if (message.fileName) return `[文件] ${message.fileName}`
      if (message.linkTitle) return `[链接] ${message.linkTitle}`
      return text || '[链接/文件]'
    case 50:
      return text || '[通话]'
    default:
      return text || `[消息类型 ${message.localType}]`
  }
}

function GroupAnalyticsPage() {
  const location = useLocation()
  const [groups, setGroups] = useState<GroupChatInfo[]>([])
  const [filteredGroups, setFilteredGroups] = useState<GroupChatInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedFunction, setSelectedFunction] = useState<AnalysisFunction | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const selectedGroup = useMemo(
    () => (selectedGroupId ? groups.find(group => group.username === selectedGroupId) || null : null),
    [groups, selectedGroupId]
  )

  // 功能数据
  const [members, setMembers] = useState<GroupMember[]>([])
  const [rankings, setRankings] = useState<GroupMessageRank[]>([])
  const [activeHours, setActiveHours] = useState<Record<number, number>>({})
  const [mediaStats, setMediaStats] = useState<{ typeCounts: Array<{ type: number; name: string; count: number }>; total: number } | null>(null)
  const [functionLoading, setFunctionLoading] = useState(false)
  const [isExportingMembers, setIsExportingMembers] = useState(false)
  const [isExportingMemberMessages, setIsExportingMemberMessages] = useState(false)
  const [memberMessages, setMemberMessages] = useState<Message[]>([])
  const [memberAnalyticsData, setMemberAnalyticsData] = useState<any | null>(null)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)
  const [memberMessagesHasMore, setMemberMessagesHasMore] = useState(false)
  const [memberMessagesCursor, setMemberMessagesCursor] = useState(0)
  const [memberMessagesLoadingMore, setMemberMessagesLoadingMore] = useState(false)
  const [selectedMessageMemberUsername, setSelectedMessageMemberUsername] = useState('')
  const [exportFolder, setExportFolder] = useState('')
  const [memberExportOptions, setMemberExportOptions] = useState<MemberMessageExportOptions>({
    format: 'excel',
    exportAvatars: true,
    exportMedia: false,
    exportImages: true,
    exportVoices: true,
    exportVideos: true,
    exportEmojis: true,
    exportVoiceAsText: false,
    displayNamePreference: 'remark'
  })

  // 成员详情弹框
  const [selectedMember, setSelectedMember] = useState<GroupMember | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [showMemberExportModal, setShowMemberExportModal] = useState(false)
  const [exportResultDialog, setExportResultDialog] = useState<{
    title: string
    message: string
    tone: 'success' | 'error'
  } | null>(null)
  const [showMessageMemberSelect, setShowMessageMemberSelect] = useState(false)
  const [showFormatSelect, setShowFormatSelect] = useState(false)
  const [showDisplayNameSelect, setShowDisplayNameSelect] = useState(false)
  const [messageMemberSearchKeyword, setMessageMemberSearchKeyword] = useState('')
  const messageMemberSelectDropdownRef = useRef<HTMLDivElement>(null)
  const formatDropdownRef = useRef<HTMLDivElement>(null)
  const displayNameDropdownRef = useRef<HTMLDivElement>(null)

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

  const memberExportFormatOptions = useMemo<MemberExportFormatOption[]>(() => ([
    { value: 'excel', label: 'Excel', desc: '电子表格，适合统计分析' },
    { value: 'txt', label: 'TXT', desc: '纯文本，通用格式' },
    { value: 'json', label: 'JSON', desc: '详细格式，包含完整消息信息' },
    { value: 'arkme-json', label: 'Arkme JSON', desc: '紧凑 JSON，支持 sender 去重与关系统计' },
    { value: 'chatlab', label: 'ChatLab', desc: '标准格式，支持其他软件导入' },
    { value: 'chatlab-jsonl', label: 'ChatLab JSONL', desc: '流式格式，适合大量消息' },
    { value: 'html', label: 'HTML', desc: '网页格式，可直接浏览' },
    { value: 'weclone', label: 'WeClone CSV', desc: 'WeClone 兼容字段格式（CSV）' }
  ]), [])
  const displayNameOptions = useMemo<Array<{
    value: MemberMessageExportOptions['displayNamePreference']
    label: string
    desc: string
  }>>(() => ([
    { value: 'group-nickname', label: '群昵称优先', desc: '仅群聊有效，私聊显示备注/昵称' },
    { value: 'remark', label: '备注优先', desc: '有备注显示备注，否则显示昵称' },
    { value: 'nickname', label: '微信昵称', desc: '始终显示微信昵称' }
  ]), [])
  const selectedMessageMember = useMemo(
    () => members.find(member => member.username === selectedMessageMemberUsername) || null,
    [members, selectedMessageMemberUsername]
  )
  const selectedFormatOption = useMemo(
    () => memberExportFormatOptions.find(option => option.value === memberExportOptions.format) || memberExportFormatOptions[0],
    [memberExportFormatOptions, memberExportOptions.format]
  )
  const selectedDisplayNameOption = useMemo(
    () => displayNameOptions.find(option => option.value === memberExportOptions.displayNamePreference) || displayNameOptions[0],
    [displayNameOptions, memberExportOptions.displayNamePreference]
  )
  const filteredMessageMemberOptions = useMemo(() => {
    return filterMembersByKeyword(members, messageMemberSearchKeyword)
  }, [members, messageMemberSearchKeyword])

  const resetMemberMessageState = useCallback((clearSelection = true) => {
    setMemberMessages([])
    setMemberMessagesHasMore(false)
    setMemberMessagesCursor(0)
    setMemberMessagesLoadingMore(false)
    setShowMessageMemberSelect(false)
    if (clearSelection) {
      setSelectedMessageMemberUsername('')
      setMessageMemberSearchKeyword('')
    }
  }, [])

  const getSelectedTimeRange = () => ({
    startTime: startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined,
    endTime: endDate ? Math.floor(new Date(`${endDate}T23:59:59`).getTime() / 1000) : undefined
  })

  const loadExportPath = useCallback(async () => {
    try {
      const savedPath = await configService.getExportPath()
      if (savedPath) {
        setExportFolder(savedPath)
        return
      }
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setExportFolder(downloadsPath)
    } catch (e) {
      console.error('加载导出路径失败:', e)
    }
  }, [])

  const loadGroups = useCallback(async () => {
    const taskId = registerBackgroundTask({
      sourcePage: 'groupAnalytics',
      title: '群列表加载',
      detail: '正在读取群聊列表',
      progressText: '群聊列表',
      cancelable: true
    })
    setIsLoading(true)
    try {
      const result = await window.electronAPI.groupAnalytics.getGroupChats()
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，群聊列表结果未继续写入'
        })
        return
      }
      if (result.success && result.data) {
        setGroups(result.data)
        setFilteredGroups(result.data)
        finishBackgroundTask(taskId, 'completed', {
          detail: `群聊列表加载完成，共 ${result.data.length} 个群`,
          progressText: `${result.data.length} 个群`
        })
      } else {
        finishBackgroundTask(taskId, 'failed', {
          detail: result.error || '加载群聊列表失败'
        })
      }
    } catch (e) {
      console.error(e)
      finishBackgroundTask(taskId, 'failed', {
        detail: String(e)
      })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGroups()
    loadExportPath()
  }, [loadGroups, loadExportPath])

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
    if (members.length === 0) {
      setSelectedMessageMemberUsername('')
      return
    }
    const messageExists = members.some(member => member.username === selectedMessageMemberUsername)
    if (!messageExists) {
      setSelectedMessageMemberUsername(members[0].username)
    }
  }, [members, selectedMessageMemberUsername])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (showMessageMemberSelect && messageMemberSelectDropdownRef.current && !messageMemberSelectDropdownRef.current.contains(target)) {
        setShowMessageMemberSelect(false)
      }
      if (showFormatSelect && formatDropdownRef.current && !formatDropdownRef.current.contains(target)) {
        setShowFormatSelect(false)
      }
      if (showDisplayNameSelect && displayNameDropdownRef.current && !displayNameDropdownRef.current.contains(target)) {
        setShowDisplayNameSelect(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDisplayNameSelect, showFormatSelect, showMessageMemberSelect])

  useEffect(() => {
    if (preselectAppliedRef.current) return
    if (groups.length === 0 || preselectGroupIds.length === 0) return

    const matchedGroup = groups.find(group => preselectGroupIds.includes(group.username))
    preselectAppliedRef.current = true

    if (matchedGroup) {
      setSelectedGroupId(matchedGroup.username)
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

  useEffect(() => {
    const handleChange = () => {
      setGroups([])
      setFilteredGroups([])
      setSelectedGroupId(null)
      setSelectedFunction(null)
      setMembers([])
      resetMemberMessageState()
      setShowMemberExportModal(false)
      setRankings([])
      setActiveHours({})
      setMediaStats(null)
      void loadGroups()
      void loadExportPath()
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [loadExportPath, loadGroups, resetMemberMessageState])

  const handleGroupSelect = (group: GroupChatInfo) => {
    setSelectedGroupId(group.username)
    setSelectedFunction(null)
    setSelectedMember(null)
    setShowMemberExportModal(false)
    resetMemberMessageState()
    setShowFormatSelect(false)
    setShowDisplayNameSelect(false)
  }


  const loadMemberMessagesPage = async (
    targetGroup: GroupChatInfo,
    memberUsername: string,
    options?: {
      cursor?: number
      append?: boolean
      startTime?: number
      endTime?: number
    }
  ): Promise<GroupMemberMessagesPage> => {
    const result = await window.electronAPI.groupAnalytics.getGroupMemberMessages(targetGroup.username, memberUsername, {
      startTime: options?.startTime,
      endTime: options?.endTime,
      limit: MEMBER_MESSAGE_PAGE_SIZE,
      cursor: options?.cursor && options.cursor > 0 ? options.cursor : undefined
    })
    if (!result.success || !result.data) {
      throw new Error(result.error || '读取成员消息失败')
    }

    setMemberMessages(prev => {
      if (!options?.append) return result.data!.messages
      const next = [...prev]
      const seen = new Set(prev.map(message => message.messageKey))
      for (const message of result.data!.messages) {
        if (seen.has(message.messageKey)) continue
        seen.add(message.messageKey)
        next.push(message)
      }
      return next
    })
    setMemberMessagesHasMore(result.data.hasMore)
    setMemberMessagesCursor(result.data.nextCursor || 0)
    return result.data
  }

  const handleFunctionSelect = async (func: AnalysisFunction) => {
    if (!selectedGroup) return
    setSelectedFunction(func)
    await loadFunctionData(func)
  }

  const loadFunctionData = async (
    func: AnalysisFunction,
    targetGroup: GroupChatInfo | null = selectedGroup,
    preferredMemberUsername?: string
  ) => {
    if (!targetGroup) return
    const taskId = registerBackgroundTask({
      sourcePage: 'groupAnalytics',
      title: `群分析：${func}`,
      detail: `正在读取 ${targetGroup.displayName || targetGroup.username} 的分析数据`,
      progressText: func,
      cancelable: true
    })
    setFunctionLoading(true)

    const { startTime, endTime } = getSelectedTimeRange()

    try {
      switch (func) {
        case 'members': {
          updateBackgroundTask(taskId, {
            detail: '正在读取群成员列表',
            progressText: '成员列表'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupMembers(targetGroup.username)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，群成员列表未继续写入' })
            return
          }
          if (result.success && result.data) setMembers(result.data)
          finishBackgroundTask(taskId, result.success ? 'completed' : 'failed', {
            detail: result.success ? `群成员列表加载完成，共 ${result.data?.length || 0} 人` : (result.error || '读取群成员列表失败'),
            progressText: result.success ? `${result.data?.length || 0} 人` : '失败'
          })
          break
        }
        case 'memberMessages': {
          resetMemberMessageState(false)
          updateBackgroundTask(taskId, {
            detail: '正在读取成员列表与消息',
            progressText: '成员消息'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupMembers(targetGroup.username)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，成员消息未继续写入' })
            return
          }
          if (!result.success || !result.data) {
            resetMemberMessageState()
            finishBackgroundTask(taskId, 'failed', {
              detail: result.error || '读取群成员失败',
              progressText: '失败'
            })
            break
          }

          setMembers(result.data)
          const targetMember = result.data.find(member => member.username === (preferredMemberUsername || selectedMessageMemberUsername)) || result.data[0]

          if (!targetMember) {
            resetMemberMessageState()
            finishBackgroundTask(taskId, 'completed', {
              detail: '当前群暂无可用成员数据',
              progressText: '0 条'
            })
            break
          }

          setSelectedMessageMemberUsername(targetMember.username)
          updateBackgroundTask(taskId, {
            detail: `正在读取 ${targetMember.displayName || targetMember.username} 的发言记录`,
            progressText: '消息分页'
          })
          const page = await loadMemberMessagesPage(targetGroup, targetMember.username, { startTime, endTime })
          finishBackgroundTask(taskId, 'completed', {
            detail: `成员消息加载完成，已读取 ${page.messages.length} 条`,
            progressText: `${page.messages.length} 条`
          })
          break
        }
        case 'memberAnalytics': {
          setMemberAnalyticsData(null)
          setAnalyticsError(null)
          updateBackgroundTask(taskId, {
            detail: '正在读取成员列表与消息分析',
            progressText: '成员分析'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupMembers(targetGroup.username)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，成员分析未继续写入' })
            return
          }
          if (!result.success || !result.data) {
            finishBackgroundTask(taskId, 'failed', { detail: result.error || '获取成员列表失败' })
            return
          }
          setMembers(result.data)
          let targetMember = preferredMemberUsername
            ? result.data.find(m => m.username === preferredMemberUsername)
            : result.data.find(m => m.username === selectedMessageMemberUsername)
          if (!targetMember && result.data.length > 0) {
            targetMember = result.data[0]
            setSelectedMessageMemberUsername(targetMember.username)
          }
          if (!targetMember) {
            finishBackgroundTask(taskId, 'failed', { detail: '找不到目标成员' })
            return
          }
          updateBackgroundTask(taskId, {
            detail: `正在分析 ${targetMember.displayName || targetMember.username} 的发言记录`,
            progressText: '统计分析'
          })
          const analyticsResult = await window.electronAPI.groupAnalytics.getGroupMemberAnalytics(targetGroup.username, targetMember.username, startTime, endTime)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，成员分析未继续写入' })
            return
          }
          if (analyticsResult.success && analyticsResult.data) {
            setMemberAnalyticsData(analyticsResult.data)
            finishBackgroundTask(taskId, 'completed', {
              detail: `分析完成，共计 ${analyticsResult.data.statistics?.totalMessages || 0} 条消息`,
              progressText: '已完成'
            })
          } else {
            setAnalyticsError(analyticsResult.error || '分析失败')
            finishBackgroundTask(taskId, 'failed', { detail: analyticsResult.error || '分析失败' })
          }
          break
        }
        case 'ranking': {
          setRankings([])
          updateBackgroundTask(taskId, {
            detail: '正在计算群消息排行',
            progressText: '消息排行'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupMessageRanking(targetGroup.username, 20, startTime, endTime)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，群消息排行未继续写入' })
            return
          }
          if (result.success && result.data) setRankings(result.data)
          finishBackgroundTask(taskId, result.success ? 'completed' : 'failed', {
            detail: result.success ? `群消息排行加载完成，共 ${result.data?.length || 0} 条` : (result.error || '读取群消息排行失败'),
            progressText: result.success ? `${result.data?.length || 0} 条` : '失败'
          })
          break
        }
        case 'activeHours': {
          setActiveHours({})
          updateBackgroundTask(taskId, {
            detail: '正在计算群活跃时段',
            progressText: '活跃时段'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupActiveHours(targetGroup.username, startTime, endTime)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，群活跃时段未继续写入' })
            return
          }
          if (result.success && result.data) setActiveHours(result.data.hourlyDistribution)
          finishBackgroundTask(taskId, result.success ? 'completed' : 'failed', {
            detail: result.success ? '群活跃时段加载完成' : (result.error || '读取群活跃时段失败'),
            progressText: result.success ? '24 小时分布' : '失败'
          })
          break
        }
        case 'mediaStats': {
          setMediaStats(null)
          updateBackgroundTask(taskId, {
            detail: '正在统计群消息类型',
            progressText: '消息类型'
          })
          const result = await window.electronAPI.groupAnalytics.getGroupMediaStats(targetGroup.username, startTime, endTime)
          if (isBackgroundTaskCancelRequested(taskId)) {
            finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载，群消息类型统计未继续写入' })
            return
          }
          if (result.success && result.data) setMediaStats(result.data)
          finishBackgroundTask(taskId, result.success ? 'completed' : 'failed', {
            detail: result.success ? `群消息类型统计完成，共 ${result.data?.total || 0} 条` : (result.error || '读取群消息类型统计失败'),
            progressText: result.success ? `${result.data?.total || 0} 条` : '失败'
          })
          break
        }
      }
    } catch (e) {
      console.error(e)
      finishBackgroundTask(taskId, 'failed', {
        detail: String(e)
      })
    } finally {
      setFunctionLoading(false)
    }
  }

  const formatNumber = (num: number) => {
    if (num >= 10000) return (num / 10000).toFixed(1) + '万'
    return num.toLocaleString()
  }

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return '-'
    const date = new Date(timestamp * 1000)
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
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
      void loadFunctionData(selectedFunction)
    }
  }

  const handleDateRangeComplete = () => {
    setDateRangeReady(true)
  }

  const handleMemberClick = (member: GroupMember) => {
    setSelectedMember(member)
    setCopiedField(null)
  }

  const openSelectedGroupChat = () => {
    if (!selectedGroup) return
    void window.electronAPI.window.openSessionChatWindow(selectedGroup.username, {
      source: 'chat',
      initialDisplayName: selectedGroup.displayName || selectedGroup.username,
      initialAvatarUrl: selectedGroup.avatarUrl,
      initialContactType: 'group'
    })
  }

  const handleMessageMemberSelect = async (memberUsername: string) => {
    if (!selectedGroup) return
    setSelectedMessageMemberUsername(memberUsername)
    setMessageMemberSearchKeyword('')
    setShowMessageMemberSelect(false)
    setFunctionLoading(true)
    try {
      const { startTime, endTime } = getSelectedTimeRange()
      await loadMemberMessagesPage(selectedGroup, memberUsername, { startTime, endTime })
    } catch (e) {
      console.error('读取成员消息失败:', e)
      alert(`读取成员消息失败：${String(e)}`)
    } finally {
      setFunctionLoading(false)
    }
  }

  const handleLoadMoreMemberMessages = async () => {
    if (!selectedGroup || !selectedMessageMemberUsername || !memberMessagesHasMore || memberMessagesLoadingMore) return
    setMemberMessagesLoadingMore(true)
    try {
      const { startTime, endTime } = getSelectedTimeRange()
      await loadMemberMessagesPage(selectedGroup, selectedMessageMemberUsername, {
        cursor: memberMessagesCursor,
        append: true,
        startTime,
        endTime
      })
    } catch (e) {
      console.error('加载更多成员消息失败:', e)
      alert(`加载更多成员消息失败：${String(e)}`)
    } finally {
      setMemberMessagesLoadingMore(false)
    }
  }

  const handleViewMemberMessagesFromModal = async (member: GroupMember) => {
    if (!selectedGroup) return
    setSelectedMember(null)
    setSelectedFunction('memberMessages')
    setSelectedMessageMemberUsername(member.username)
    setMessageMemberSearchKeyword('')
    setShowMessageMemberSelect(false)
    await loadFunctionData('memberMessages', selectedGroup, member.username)
  }

  const handleViewMemberAnalyticsFromModal = async (member: GroupMember) => {
    if (!selectedGroup) return
    setSelectedMember(null)
    setSelectedFunction('memberAnalytics')
    setSelectedMessageMemberUsername(member.username)
    setMessageMemberSearchKeyword('')
    setShowMessageMemberSelect(false)
    await loadFunctionData('memberAnalytics', selectedGroup, member.username)
  }

  const handleOpenMemberExportModal = () => {
    setShowMessageMemberSelect(false)
    setShowFormatSelect(false)
    setShowDisplayNameSelect(false)
    setShowMemberExportModal(true)
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
        setExportResultDialog({
          title: '导出成功',
          message: `共导出 ${result.count ?? members.length} 人`,
          tone: 'success'
        })
      } else {
        setExportResultDialog({
          title: '导出失败',
          message: result.error || '未知错误',
          tone: 'error'
        })
      }
    } catch (e) {
      console.error('导出群成员失败:', e)
      setExportResultDialog({
        title: '导出失败',
        message: String(e),
        tone: 'error'
      })
    } finally {
      setIsExportingMembers(false)
    }
  }

  const handleMemberExportFormatChange = (format: MemberExportFormat) => {
    setMemberExportOptions(prev => {
      const next = { ...prev, format }
      if (format === 'html') {
        return {
          ...next,
          exportMedia: true,
          exportImages: true,
          exportVoices: true,
          exportVideos: true,
          exportEmojis: true
        }
      }
      return next
    })
  }

  const handleChooseExportFolder = async () => {
    try {
      const result = await window.electronAPI.dialog.openDirectory({
        title: '选择导出目录'
      })
      if (!result.canceled && result.filePaths.length > 0) {
        setExportFolder(result.filePaths[0])
        await configService.setExportPath(result.filePaths[0])
      }
    } catch (e) {
      console.error('选择导出目录失败:', e)
      alert(`选择导出目录失败：${String(e)}`)
    }
  }

  const handleExportMemberMessages = async () => {
    if (!selectedGroup || !selectedMessageMemberUsername || !exportFolder || isExportingMemberMessages) return
    const member = members.find(item => item.username === selectedMessageMemberUsername)
    if (!member) {
      alert('请先选择成员')
      return
    }

    setIsExportingMemberMessages(true)
    try {
      const hasDateRange = Boolean(startDate && endDate)
      const result = await window.electronAPI.export.exportSessions(
        [selectedGroup.username],
        exportFolder,
        {
          format: memberExportOptions.format,
          dateRange: hasDateRange
            ? {
              start: Math.floor(new Date(startDate).getTime() / 1000),
              end: Math.floor(new Date(`${endDate}T23:59:59`).getTime() / 1000)
            }
            : null,
          exportAvatars: memberExportOptions.exportAvatars,
          exportMedia: memberExportOptions.exportMedia,
          exportImages: memberExportOptions.exportMedia && memberExportOptions.exportImages,
          exportVoices: memberExportOptions.exportMedia && memberExportOptions.exportVoices,
          exportVideos: memberExportOptions.exportMedia && memberExportOptions.exportVideos,
          exportEmojis: memberExportOptions.exportMedia && memberExportOptions.exportEmojis,
          exportVoiceAsText: memberExportOptions.exportVoiceAsText,
          sessionLayout: memberExportOptions.exportMedia ? 'per-session' : 'shared',
          displayNamePreference: memberExportOptions.displayNamePreference,
          senderUsername: member.username,
          fileNameSuffix: sanitizeFileName(member.displayName || member.username)
        }
      )
      if (result.success && (result.successCount ?? 0) > 0) {
        setShowMemberExportModal(false)
        setExportResultDialog({
          title: '导出成功',
          message: `已导出 ${member.displayName || member.username}`,
          tone: 'success'
        })
      } else {
        setExportResultDialog({
          title: '导出失败',
          message: result.error || '未知错误',
          tone: 'error'
        })
      }
    } catch (e) {
      console.error('导出成员消息失败:', e)
      setExportResultDialog({
        title: '导出失败',
        message: String(e),
        tone: 'error'
      })
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
            <div className="member-modal-actions">
              <button
                type="button"
                className="member-modal-primary-btn"
                onClick={() => void handleViewMemberAnalyticsFromModal(selectedMember)}
              >
                <BarChart3 size={16} />
                <span>分析该成员聊天</span>
              </button>
              <button
                type="button"
                className="member-modal-secondary-btn"
                onClick={() => void handleViewMemberMessagesFromModal(selectedMember)}
              >
                <MessageSquare size={16} />
                <span>查看该成员消息</span>
              </button>
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
              className={`group-item ${selectedGroupId === group.username ? 'active' : ''}`}
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
        <div className="selected-group-meta">
          <span className="group-summary-label">已选择群聊</span>
          <h2>{selectedGroup?.displayName}</h2>
          <p>{selectedGroup?.memberCount} 位成员</p>
        </div>
      </div>
      <div className="function-grid">
        <div className="function-card" onClick={() => handleFunctionSelect('members')}>
          <Users size={32} />
          <span>群成员查看</span>
          <small>查看群成员列表和基础资料</small>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('memberMessages')}>
          <MessageSquare size={32} />
          <span>成员消息筛选与导出</span>
          <small>按成员查看群聊消息，并支持导出当前成员记录</small>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('memberAnalytics')}>
          <PieChart size={32} />
          <span>群成员详细分析</span>
          <small>针对群聊内某一用户的群聊记录进行详细分析，如发信数量、活跃周期等</small>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('ranking')}>
          <BarChart3 size={32} />
          <span>群聊发言排行</span>
          <small>统计成员发言数量排行</small>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('activeHours')}>
          <Clock size={32} />
          <span>群聊活跃时段</span>
          <small>查看全天活跃时间分布</small>
        </div>
        <div className="function-card" onClick={() => handleFunctionSelect('mediaStats')}>
          <Image size={32} />
          <span>媒体内容统计</span>
          <small>统计文本、图片、语音等类型</small>
        </div>
      </div>
    </div>
  )

  const renderFunctionContent = () => {
    const getFunctionTitle = () => {
      switch (selectedFunction) {
        case 'members': return '群成员查看'
        case 'memberMessages': return '成员消息筛选与导出'
        case 'memberAnalytics': return '群成员详细分析'
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
          {selectedFunction === 'memberMessages' && (
            <button className="export-btn" onClick={openSelectedGroupChat}>
              <MessageSquare size={16} />
              <span>打开群聊</span>
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
              {selectedFunction === 'memberMessages' && (
                <div className="member-messages-panel">
                  {members.length === 0 ? (
                    <div className="member-message-empty">暂无群成员数据，请先刷新。</div>
                  ) : (
                    <>
                      <div className="member-message-summary-text">已加载 {memberMessages.length} 条消息</div>

                      <div className="member-message-toolbar">
                        <div className="member-export-field" ref={messageMemberSelectDropdownRef}>
                          <span>查看成员</span>
                          <button
                            type="button"
                            className={`select-trigger member-message-select-trigger ${showMessageMemberSelect ? 'open' : ''}`}
                            onClick={() => {
                              setShowMessageMemberSelect(prev => !prev)
                              setShowFormatSelect(false)
                              setShowDisplayNameSelect(false)
                            }}
                          >
                            <div className="member-select-trigger-value">
                              <Avatar
                                src={selectedMessageMember?.avatarUrl}
                                name={selectedMessageMember?.displayName || selectedMessageMember?.username || '?'}
                                size={24}
                              />
                              <span className="select-value">{selectedMessageMember?.displayName || selectedMessageMember?.username || '请选择成员'}</span>
                            </div>
                            <ChevronDown size={16} />
                          </button>
                          {showMessageMemberSelect && (
                            <div className="select-dropdown member-select-dropdown">
                              <div className="member-select-search">
                                <Search size={14} />
                                <input
                                  type="text"
                                  value={messageMemberSearchKeyword}
                                  onChange={e => setMessageMemberSearchKeyword(e.target.value)}
                                  placeholder="搜索 wxid / 昵称 / 备注 / 微信号"
                                />
                              </div>
                              <div className="member-select-options">
                                {filteredMessageMemberOptions.length === 0 ? (
                                  <div className="member-select-empty">无匹配成员</div>
                                ) : (
                                  filteredMessageMemberOptions.map(member => (
                                    <button
                                      key={member.username}
                                      type="button"
                                      className={`select-option member-select-option ${selectedMessageMemberUsername === member.username ? 'active' : ''}`}
                                      onClick={() => void handleMessageMemberSelect(member.username)}
                                    >
                                      <Avatar src={member.avatarUrl} name={member.displayName} size={28} />
                                      <span className="member-option-main">{member.displayName || member.username}</span>
                                      <span className="member-option-meta">
                                        wxid: {member.username}
                                        {member.alias ? ` · 微信号: ${member.alias}` : ''}
                                        {member.remark ? ` · 备注: ${member.remark}` : ''}
                                        {member.nickname ? ` · 昵称: ${member.nickname}` : ''}
                                        {member.groupNickname ? ` · 群昵称: ${member.groupNickname}` : ''}
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="member-message-toolbar-actions">
                          <button
                            className="member-export-start-btn"
                            onClick={handleOpenMemberExportModal}
                            disabled={!selectedMessageMemberUsername}
                          >
                            <Download size={16} />
                            <span>导出</span>
                          </button>
                        </div>
                      </div>

                      {memberMessages.length === 0 ? (
                        <div className="member-message-empty">当前时间范围内暂无该成员消息。</div>
                      ) : (
                        <div className="member-message-list">
                          {memberMessages.map(message => (
                            <div key={message.messageKey || `${message.localId}-${message.createTime}`} className="member-message-item">
                              <div className="member-message-meta">
                                <span className="member-message-time">{formatMemberMessageTime(message.createTime)}</span>
                                <span className="member-message-type">{getMemberMessageTypeLabel(message)}</span>
                              </div>
                              <div className="member-message-content">{getMemberMessagePreview(message)}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {(memberMessagesHasMore || memberMessages.length > 0) && (
                        <div className="member-message-actions">
                          {memberMessagesHasMore ? (
                            <button
                              type="button"
                              className="member-message-load-more"
                              disabled={memberMessagesLoadingMore}
                              onClick={() => void handleLoadMoreMemberMessages()}
                            >
                              {memberMessagesLoadingMore ? <Loader2 size={16} className="spin" /> : null}
                              <span>{memberMessagesLoadingMore ? '加载中...' : '加载更多'}</span>
                            </button>
                          ) : (
                            <span className="member-message-end">已显示当前可读取的全部消息</span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {selectedFunction === 'memberAnalytics' && (
                <div className="member-analytics-panel">
                  {members.length === 0 ? (
                    <div className="member-message-empty">暂无群成员数据，请先刷新。</div>
                  ) : (
                    <>
                      <div className="member-message-toolbar" style={{ marginBottom: 20 }}>
                        <div className="member-export-field" ref={messageMemberSelectDropdownRef}>
                          <span>分析成员</span>
                          <button
                            type="button"
                            className={`select-trigger member-message-select-trigger ${showMessageMemberSelect ? 'open' : ''}`}
                            onClick={() => setShowMessageMemberSelect(prev => !prev)}
                          >
                            <div className="member-select-trigger-value">
                              <Avatar
                                src={selectedMessageMember?.avatarUrl}
                                name={selectedMessageMember?.displayName || selectedMessageMember?.username || '?'}
                                size={24}
                              />
                              <span className="select-value">{selectedMessageMember?.displayName || selectedMessageMember?.username || '请选择成员'}</span>
                            </div>
                            <ChevronDown size={16} />
                          </button>
                          {showMessageMemberSelect && (
                            <div className="select-dropdown member-select-dropdown">
                              <div className="member-select-search">
                                <Search size={14} />
                                <input
                                  type="text"
                                  value={messageMemberSearchKeyword}
                                  onChange={e => setMessageMemberSearchKeyword(e.target.value)}
                                  placeholder="搜索 wxid / 昵称 / 备注 / 微信号"
                                  onClick={e => e.stopPropagation()}
                                />
                              </div>
                              <div className="member-select-options">
                                {filteredMessageMemberOptions.length === 0 ? (
                                  <div className="member-select-empty">无匹配成员</div>
                                ) : (
                                  filteredMessageMemberOptions.map(member => (
                                    <button
                                      key={member.username}
                                      type="button"
                                      className={`select-option member-select-option ${selectedMessageMemberUsername === member.username ? 'active' : ''}`}
                                      onClick={() => {
                                        setSelectedMessageMemberUsername(member.username)
                                        setShowMessageMemberSelect(false)
                                        if (selectedGroup) {
                                          void loadFunctionData('memberAnalytics', selectedGroup, member.username)
                                        }
                                      }}
                                    >
                                      <Avatar src={member.avatarUrl} name={member.displayName} size={28} />
                                      <span className="member-option-main">{member.displayName || member.username}</span>
                                      <span className="member-option-meta">
                                        wxid: {member.username}
                                        {member.alias ? ` · 微信号: ${member.alias}` : ''}
                                        {member.remark ? ` · 备注: ${member.remark}` : ''}
                                        {member.nickname ? ` · 昵称: ${member.nickname}` : ''}
                                        {member.groupNickname ? ` · 群昵称: ${member.groupNickname}` : ''}
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      {analyticsError ? (
                        <div className="member-message-empty">{analyticsError}</div>
                      ) : memberAnalyticsData ? (
                        <div className="analytics-content-scrollable" style={{ padding: '0', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}>
                          <div className="stats-overview">
                            <div className="stat-card">
                              <div className="stat-icon"><MessageSquare size={24} /></div>
                              <div className="stat-info">
                                <span className="stat-value">{formatNumber(memberAnalyticsData.statistics.sentMessages)}</span>
                                <span className="stat-label">发信数量</span>
                              </div>
                            </div>
                            <div className="stat-card">
                              <div className="stat-icon"><Clock size={24} /></div>
                              <div className="stat-info">
                                <span className="stat-value">{memberAnalyticsData.statistics.activeDays}</span>
                                <span className="stat-label">活跃天数</span>
                              </div>
                            </div>
                            <div className="stat-card" style={{ gridColumn: 'span 2' }}>
                              <div className="stat-icon"><Calendar size={24} /></div>
                              <div className="stat-info">
                                <span className="stat-value">
                                  {formatDate(memberAnalyticsData.statistics.firstMessageTime)} - {formatDate(memberAnalyticsData.statistics.lastMessageTime)}
                                </span>
                                <span className="stat-label">活跃周期</span>
                              </div>
                            </div>
                          </div>
                          
                          <div className="charts-grid">
                            <div className="chart-card wide">
                              <h3>活跃时段</h3>
                              <div className="chart-wrapper">
                                <ReactECharts 
                                  option={{
                                    tooltip: { trigger: 'axis' },
                                    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => `${i}时`) },
                                    yAxis: { type: 'value' },
                                    series: [{ type: 'bar', data: Array.from({ length: 24 }, (_, i) => memberAnalyticsData.timeDistribution[i] || 0), itemStyle: { color: '#07c160', borderRadius: [4, 4, 0, 0] } }]
                                  }} 
                                  style={{ height: '300px', width: '100%' }} 
                                />
                              </div>
                            </div>
                            
                            <div className="chart-card wide">
                              <h3>消息类型分布</h3>
                              <div className="chart-wrapper">
                                <ReactECharts 
                                  option={{
                                    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
                                    series: [{
                                      type: 'pie',
                                      radius: ['40%', '70%'],
                                      data: [
                                        { name: '文本', value: memberAnalyticsData.statistics.textMessages, itemStyle: { color: '#3b82f6' } },
                                        { name: '图片', value: memberAnalyticsData.statistics.imageMessages, itemStyle: { color: '#22c55e' } },
                                        { name: '语音', value: memberAnalyticsData.statistics.voiceMessages, itemStyle: { color: '#f97316' } },
                                        { name: '视频', value: memberAnalyticsData.statistics.videoMessages, itemStyle: { color: '#a855f7' } },
                                        { name: '表情', value: memberAnalyticsData.statistics.emojiMessages, itemStyle: { color: '#ec4899' } },
                                        { name: '其他', value: memberAnalyticsData.statistics.otherMessages, itemStyle: { color: '#6b7280' } }
                                      ].filter(item => item.value > 0),
                                      label: { show: true, formatter: '{b} {d}%' }
                                    }]
                                  }} 
                                  style={{ height: '300px', width: '100%' }} 
                                />
                              </div>
                            </div>
                            <div className="chart-card wide" style={{ display: 'flex', gap: '32px' }}>
                              <div style={{ flex: 1 }}>
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Hash size={18} /> 常用语</h3>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                  {memberAnalyticsData.commonPhrases && memberAnalyticsData.commonPhrases.length > 0 ? (
                                    memberAnalyticsData.commonPhrases.map((item: any, idx: number) => (
                                      <div key={idx} style={{ background: 'var(--bg-tertiary)', padding: '6px 12px', borderRadius: '8px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', border: '1px solid var(--border-color)' }}>
                                        <span style={{ color: 'var(--text-primary)' }}>{item.phrase}</span>
                                        <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>{item.count}次</span>
                                      </div>
                                    ))
                                  ) : (
                                    <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>暂无常用语数据</span>
                                  )}
                                </div>
                              </div>
                              <div style={{ flex: 1 }}>
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Smile size={18} /> 常用表情</h3>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                  {memberAnalyticsData.commonEmojis && memberAnalyticsData.commonEmojis.length > 0 ? (
                                    memberAnalyticsData.commonEmojis.map((item: any, idx: number) => (
                                      <div key={idx} style={{ background: 'var(--bg-tertiary)', padding: '6px 12px', borderRadius: '8px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', border: '1px solid var(--border-color)' }}>
                                        <span style={{ color: 'var(--text-primary)' }}>{item.emoji}</span>
                                        <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>{item.count}次</span>
                                      </div>
                                    ))
                                  ) : (
                                    <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>暂无表情包数据</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="content-loading"><Loader2 size={32} className="spin" /></div>
                      )}
                    </>
                  )}
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
    if (selectedFunction) {
      return renderFunctionContent()
    }

    if (!selectedGroup) {
      return (
        <>
          <div className="detail-drag-region" aria-hidden="true" />
          <div className="placeholder">
            <Users size={64} />
          <p>请从左侧选择一个群聊进行分析</p>
          </div>
        </>
      )
    }
    return (
      <>
        <div className="detail-drag-region" aria-hidden="true" />
        {renderFunctionMenu()}
      </>
    )
  }

  const renderMemberExportModal = () => {
    if (!showMemberExportModal) return null

    return (
      <div className="member-modal-overlay" onClick={() => setShowMemberExportModal(false)}>
        <div className="member-export-modal" onClick={e => e.stopPropagation()}>
          <button className="modal-close" onClick={() => setShowMemberExportModal(false)}>
            <X size={20} />
          </button>
          <div className="member-export-modal-header">
            <h3>导出成员消息</h3>
            <p>{selectedMessageMember?.displayName || selectedMessageMember?.username || '未选择成员'}</p>
          </div>

          <div className="member-export-panel">
            <div className="member-export-grid">
              <div className="member-export-field" ref={formatDropdownRef}>
                <span>导出格式</span>
                <button
                  type="button"
                  className={`select-trigger ${showFormatSelect ? 'open' : ''}`}
                  onClick={() => {
                    setShowFormatSelect(prev => !prev)
                    setShowDisplayNameSelect(false)
                  }}
                >
                  <span className="select-value">{selectedFormatOption.label}</span>
                  <ChevronDown size={16} />
                </button>
                {showFormatSelect && (
                  <div className="select-dropdown">
                    {memberExportFormatOptions.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        className={`select-option ${memberExportOptions.format === option.value ? 'active' : ''}`}
                        onClick={() => {
                          handleMemberExportFormatChange(option.value)
                          setShowFormatSelect(false)
                        }}
                      >
                        <span className="option-label">{option.label}</span>
                        <span className="option-desc">{option.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="member-export-field member-export-folder">
                <span>导出目录</span>
                <div className="member-export-folder-row">
                  <input value={exportFolder} readOnly placeholder="请选择导出目录" />
                  <button type="button" onClick={handleChooseExportFolder}>
                    选择目录
                  </button>
                </div>
              </div>
            </div>

            <div className="member-export-options">
              <div className="member-export-chip-group">
                <span className="chip-group-label">媒体导出</span>
                <button
                  type="button"
                  className={`export-filter-chip ${memberExportOptions.exportMedia ? 'active' : ''}`}
                  onClick={() => setMemberExportOptions(prev => ({ ...prev, exportMedia: !prev.exportMedia }))}
                >
                  导出媒体文件
                </button>
              </div>
              <div className="member-export-chip-group">
                <span className="chip-group-label">媒体类型</span>
                <div className="member-export-chip-list">
                  <button
                    type="button"
                    className={`export-filter-chip ${memberExportOptions.exportImages ? 'active' : ''} ${!memberExportOptions.exportMedia ? 'disabled' : ''}`}
                    disabled={!memberExportOptions.exportMedia}
                    onClick={() => setMemberExportOptions(prev => ({ ...prev, exportImages: !prev.exportImages }))}
                  >
                    图片
                  </button>
                  <button
                    type="button"
                    className={`export-filter-chip ${memberExportOptions.exportVoices ? 'active' : ''} ${!memberExportOptions.exportMedia ? 'disabled' : ''}`}
                    disabled={!memberExportOptions.exportMedia}
                    onClick={() => setMemberExportOptions(prev => ({ ...prev, exportVoices: !prev.exportVoices }))}
                  >
                    语音
                  </button>
                  <button
                    type="button"
                    className={`export-filter-chip ${memberExportOptions.exportVideos ? 'active' : ''} ${!memberExportOptions.exportMedia ? 'disabled' : ''}`}
                    disabled={!memberExportOptions.exportMedia}
                    onClick={() => setMemberExportOptions(prev => ({ ...prev, exportVideos: !prev.exportVideos }))}
                  >
                    视频
                  </button>
                  <button
                    type="button"
                    className={`export-filter-chip ${memberExportOptions.exportEmojis ? 'active' : ''} ${!memberExportOptions.exportMedia ? 'disabled' : ''}`}
                    disabled={!memberExportOptions.exportMedia}
                    onClick={() => setMemberExportOptions(prev => ({ ...prev, exportEmojis: !prev.exportEmojis }))}
                  >
                    表情
                  </button>
                </div>
              </div>
              <div className="member-export-chip-group">
                <span className="chip-group-label">附加选项</span>
                <div className="member-export-chip-list">
                  <button
                    type="button"
                    className={`export-filter-chip ${memberExportOptions.exportVoiceAsText ? 'active' : ''}`}
                    onClick={() => setMemberExportOptions(prev => ({ ...prev, exportVoiceAsText: !prev.exportVoiceAsText }))}
                  >
                    语音转文字
                  </button>
                  <button
                    type="button"
                    className={`export-filter-chip ${memberExportOptions.exportAvatars ? 'active' : ''}`}
                    onClick={() => setMemberExportOptions(prev => ({ ...prev, exportAvatars: !prev.exportAvatars }))}
                  >
                    导出头像
                  </button>
                </div>
              </div>
              <div className="member-export-field" ref={displayNameDropdownRef}>
                <span>显示名称规则</span>
                <button
                  type="button"
                  className={`select-trigger ${showDisplayNameSelect ? 'open' : ''}`}
                  onClick={() => {
                    setShowDisplayNameSelect(prev => !prev)
                    setShowFormatSelect(false)
                  }}
                >
                  <span className="select-value">{selectedDisplayNameOption.label}</span>
                  <ChevronDown size={16} />
                </button>
                {showDisplayNameSelect && (
                  <div className="select-dropdown">
                    {displayNameOptions.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        className={`select-option ${memberExportOptions.displayNamePreference === option.value ? 'active' : ''}`}
                        onClick={() => {
                          setMemberExportOptions(prev => ({ ...prev, displayNamePreference: option.value }))
                          setShowDisplayNameSelect(false)
                        }}
                      >
                        <span className="option-label">{option.label}</span>
                        <span className="option-desc">{option.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="member-export-actions">
              <button
                className="member-export-start-btn"
                onClick={handleExportMemberMessages}
                disabled={isExportingMemberMessages || !selectedMessageMemberUsername || !exportFolder}
              >
                {isExportingMemberMessages ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
                <span>{isExportingMemberMessages ? '导出中...' : '开始导出'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderExportResultDialog = () => {
    if (!exportResultDialog) return null

    return (
      <div className="member-modal-overlay" onClick={() => setExportResultDialog(null)}>
        <div className={`member-result-modal ${exportResultDialog.tone}`} onClick={e => e.stopPropagation()}>
          <button className="modal-close" onClick={() => setExportResultDialog(null)}>
            <X size={20} />
          </button>
          <div className="member-result-modal-body">
            <h3>{exportResultDialog.title}</h3>
            <p>{exportResultDialog.message}</p>
          </div>
          <div className="member-result-modal-actions">
            <button type="button" className="member-result-modal-btn" onClick={() => setExportResultDialog(null)}>
              知道了
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group-analytics-shell">
      <ChatAnalysisHeader currentMode="group" />
      <div className={`group-analytics-page ${isResizing ? 'resizing' : ''}`} ref={containerRef}>
        {renderGroupList()}
        <div className="resize-handle" onMouseDown={() => setIsResizing(true)} />
        <div className="detail-area">
          {renderDetailPanel()}
        </div>
      </div>
      {renderMemberModal()}
      {renderMemberExportModal()}
      {renderExportResultDialog()}
    </div>
  )
}

export default GroupAnalyticsPage

