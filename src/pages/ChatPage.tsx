import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, MessageSquare, AlertCircle, Loader2, RefreshCw, X, ChevronDown, ChevronLeft, Info, Calendar, Database, Hash, Play, Pause, Image as ImageIcon, Mic, CheckCircle, Copy, Check, CheckSquare, Download, BarChart3, Edit2, Trash2, BellOff, Users, FolderClosed, UserCheck, Crown, Aperture, Newspaper } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../stores/chatStore'
import { useBatchTranscribeStore, type BatchVoiceTaskType } from '../stores/batchTranscribeStore'
import { useBatchImageDecryptStore } from '../stores/batchImageDecryptStore'
import type { ChatRecordItem, ChatSession, Message } from '../types/models'
import { getEmojiPath } from 'wechat-emojis'
import { VoiceTranscribeDialog } from '../components/VoiceTranscribeDialog'
import { LivePhotoIcon } from '../components/LivePhotoIcon'
import { AnimatedStreamingText } from '../components/AnimatedStreamingText'
import JumpToDatePopover from '../components/JumpToDatePopover'
import { ContactSnsTimelineDialog } from '../components/Sns/ContactSnsTimelineDialog'
import { type ContactSnsTimelineTarget, isSingleContactSession } from '../components/Sns/contactSnsTimeline'
import * as configService from '../services/config'
import BizPage, { BizAccountList, BizMessageArea, BizAccount } from './BizPage'
import {
  finishBackgroundTask,
  isBackgroundTaskCancelRequested,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import {
  emitOpenSingleExport,
  onExportSessionStatus,
  onSingleExportDialogStatus,
  requestExportSessionStatus
} from '../services/exportBridge'
import './ChatPage.scss'

// 系统消息类型常量
const SYSTEM_MESSAGE_TYPES = [
  10000,        // 系统消息
  266287972401, // 拍一拍
]

const OFFICIAL_ACCOUNTS_VIRTUAL_ID = 'official_accounts_virtual'

interface PendingInSessionSearchPayload {
  sessionId: string
  keyword: string
  firstMsgTime: number
  results: Message[]
}

type GlobalMsgSearchPhase = 'idle' | 'seed' | 'backfill' | 'done'
type GlobalMsgSearchResult = Message & { sessionId: string }

interface GlobalMsgPrefixCacheEntry {
  keyword: string
  matchedSessionIds: Set<string>
  completed: boolean
}

type QuoteLayout = configService.QuoteLayout

const GLOBAL_MSG_PER_SESSION_LIMIT = 10
const GLOBAL_MSG_SEED_LIMIT = 120
const GLOBAL_MSG_BACKFILL_CONCURRENCY = 3
const GLOBAL_MSG_LEGACY_CONCURRENCY = 6
const GLOBAL_MSG_SEARCH_CANCELED_ERROR = '__WEFLOW_GLOBAL_MSG_SEARCH_CANCELED__'
const GLOBAL_MSG_SHADOW_COMPARE_SAMPLE_RATE = 0.2
const GLOBAL_MSG_SHADOW_COMPARE_STORAGE_KEY = 'weflow.debug.searchShadowCompare'
const MESSAGE_LIST_SCROLL_IDLE_MS = 160
const MESSAGE_TOP_WHEEL_LOAD_COOLDOWN_MS = 160
const MESSAGE_EDGE_TRIGGER_DISTANCE_PX = 96

type RequestIdleCallbackCompat = (callback: () => void, options?: { timeout?: number }) => number

function scheduleWhenIdle(task: () => void, options?: { timeout?: number; fallbackDelay?: number }): void {
  const requestIdleCallbackFn = (
    globalThis as typeof globalThis & { requestIdleCallback?: RequestIdleCallbackCompat }
  ).requestIdleCallback

  if (typeof requestIdleCallbackFn === 'function') {
    requestIdleCallbackFn(task, options?.timeout !== undefined ? { timeout: options.timeout } : undefined)
    return
  }

  window.setTimeout(task, options?.fallbackDelay ?? 0)
}

function isGlobalMsgSearchCanceled(error: unknown): boolean {
  return String(error || '') === GLOBAL_MSG_SEARCH_CANCELED_ERROR
}

function normalizeGlobalMsgSearchSessionId(value: unknown): string | null {
  const sessionId = String(value || '').trim()
  if (!sessionId) return null
  return sessionId
}

function normalizeGlobalMsgSearchMessages(
  messages: Message[] | undefined,
  fallbackSessionId?: string
): GlobalMsgSearchResult[] {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const dedup = new Set<string>()
  const normalized: GlobalMsgSearchResult[] = []
  const normalizedFallback = normalizeGlobalMsgSearchSessionId(fallbackSessionId)

  for (const message of messages) {
    const raw = message as Message & { sessionId?: string; _session_id?: string }
    const sessionId = normalizeGlobalMsgSearchSessionId(raw.sessionId || raw._session_id || normalizedFallback)
    if (!sessionId) continue
    const uniqueKey = raw.localId > 0
      ? `${sessionId}::local:${raw.localId}`
      : `${sessionId}::key:${raw.messageKey || ''}:${raw.createTime || 0}`
    if (dedup.has(uniqueKey)) continue
    dedup.add(uniqueKey)
    normalized.push({ ...message, sessionId })
  }

  return normalized
}

function buildGlobalMsgSearchSessionMap(messages: GlobalMsgSearchResult[]): Map<string, GlobalMsgSearchResult[]> {
  const map = new Map<string, GlobalMsgSearchResult[]>()
  for (const message of messages) {
    if (!message.sessionId) continue
    const list = map.get(message.sessionId) || []
    if (list.length >= GLOBAL_MSG_PER_SESSION_LIMIT) continue
    list.push(message)
    map.set(message.sessionId, list)
  }
  return map
}

function flattenGlobalMsgSearchSessionMap(map: Map<string, GlobalMsgSearchResult[]>): GlobalMsgSearchResult[] {
  const all: GlobalMsgSearchResult[] = []
  for (const list of map.values()) {
    if (list.length > 0) all.push(...list)
  }
  return sortMessagesByCreateTimeDesc(all)
}

function normalizeChatRecordText(value?: string): string {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasRenderableChatRecordName(value?: string): boolean {
  return value !== undefined && value !== null && String(value).length > 0
}

function getChatRecordPreviewText(item: ChatRecordItem): string {
  const text = normalizeChatRecordText(item.datadesc) || normalizeChatRecordText(item.datatitle)
  if (item.datatype === 17) {
    return normalizeChatRecordText(item.chatRecordTitle) || normalizeChatRecordText(item.datatitle) || '聊天记录'
  }
  if (item.datatype === 2 || item.datatype === 3) return '[媒体消息]'
  if (item.datatype === 43) return '[视频]'
  if (item.datatype === 34) return '[语音]'
  if (item.datatype === 47) return '[表情]'
  return text || '[媒体消息]'
}

function buildChatRecordPreviewItems(recordList: ChatRecordItem[], maxVisible = 3): ChatRecordItem[] {
  if (recordList.length <= maxVisible) return recordList.slice(0, maxVisible)
  const firstNestedIndex = recordList.findIndex(item => item.datatype === 17)
  if (firstNestedIndex < 0 || firstNestedIndex < maxVisible) {
    return recordList.slice(0, maxVisible)
  }
  if (maxVisible <= 1) {
    return [recordList[firstNestedIndex]]
  }
  return [
    ...recordList.slice(0, maxVisible - 1),
    recordList[firstNestedIndex]
  ]
}

function composeGlobalMsgSearchResults(
  seedMap: Map<string, GlobalMsgSearchResult[]>,
  authoritativeMap: Map<string, GlobalMsgSearchResult[]>
): GlobalMsgSearchResult[] {
  const merged = new Map<string, GlobalMsgSearchResult[]>()
  for (const [sessionId, seedRows] of seedMap.entries()) {
    if (authoritativeMap.has(sessionId)) {
      merged.set(sessionId, authoritativeMap.get(sessionId) || [])
    } else {
      merged.set(sessionId, seedRows)
    }
  }
  for (const [sessionId, rows] of authoritativeMap.entries()) {
    if (!merged.has(sessionId)) merged.set(sessionId, rows)
  }
  return flattenGlobalMsgSearchSessionMap(merged)
}

function shouldRunGlobalMsgShadowCompareSample(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    const forced = window.localStorage.getItem(GLOBAL_MSG_SHADOW_COMPARE_STORAGE_KEY)
    if (forced === '1') return true
    if (forced === '0') return false
  } catch {
    // ignore storage read failures
  }
  return Math.random() < GLOBAL_MSG_SHADOW_COMPARE_SAMPLE_RATE
}

function buildGlobalMsgSearchSessionLocalIds(results: GlobalMsgSearchResult[]): Record<string, number[]> {
  const grouped = new Map<string, number[]>()
  for (const row of results) {
    if (!row.sessionId || row.localId <= 0) continue
    const list = grouped.get(row.sessionId) || []
    list.push(row.localId)
    grouped.set(row.sessionId, list)
  }
  const output: Record<string, number[]> = {}
  for (const [sessionId, localIds] of grouped.entries()) {
    output[sessionId] = localIds
  }
  return output
}

function sortMessagesByCreateTimeDesc<T extends Pick<Message, 'createTime' | 'localId'>>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const timeDiff = (b.createTime || 0) - (a.createTime || 0)
    if (timeDiff !== 0) return timeDiff
    return (b.localId || 0) - (a.localId || 0)
  })
}

function isRenderableImageSrc(value?: string | null): boolean {
  const src = String(value || '').trim()
  if (!src) return false
  return /^(https?:\/\/|data:image\/|blob:|file:\/\/|\/)/i.test(src)
}

function normalizeSearchIdentityText(value?: string | null): string | undefined {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  const lower = normalized.toLowerCase()
  if (normalized === '未知' || lower === 'unknown' || lower === 'null' || lower === 'undefined') {
    return undefined
  }
  if (lower.startsWith('unknown_sender_')) {
    return undefined
  }
  return normalized
}

function normalizeSearchAvatarUrl(value?: string | null): string | undefined {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  const lower = normalized.toLowerCase()
  if (lower === 'null' || lower === 'undefined') {
    return undefined
  }
  return normalized
}

function resolveSessionDisplayName(
  displayName?: string | null,
  sessionId?: string | null
): string | undefined {
  const normalizedSessionId = String(sessionId || '').trim()
  const normalizedDisplayName = normalizeSearchIdentityText(displayName)
  if (!normalizedDisplayName) return undefined
  if (normalizedSessionId && normalizedDisplayName === normalizedSessionId) return undefined
  return normalizedDisplayName
}

function isFoldPlaceholderSession(sessionId?: string | null): boolean {
  return String(sessionId || '').toLowerCase().includes('placeholder_foldgroup')
}

function isWxidLikeSearchIdentity(value?: string | null): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return false
  if (normalized.startsWith('wxid_')) return true
  const suffixMatch = normalized.match(/^(.+)_([a-z0-9]{4})$/i)
  return Boolean(suffixMatch && suffixMatch[1].startsWith('wxid_'))
}

function resolveSearchSenderDisplayName(
  displayName?: string | null,
  senderUsername?: string | null,
  sessionId?: string | null
): string | undefined {
  const normalizedDisplayName = normalizeSearchIdentityText(displayName)
  if (!normalizedDisplayName) return undefined

  const normalizedSenderUsername = normalizeSearchIdentityText(senderUsername)
  const normalizedSessionId = normalizeSearchIdentityText(sessionId)

  if (normalizedSessionId && normalizedDisplayName === normalizedSessionId) {
    return undefined
  }
  if (isWxidLikeSearchIdentity(normalizedDisplayName)) {
    return undefined
  }
  if (
    normalizedSenderUsername &&
    normalizedDisplayName === normalizedSenderUsername &&
    isWxidLikeSearchIdentity(normalizedSenderUsername)
  ) {
    return undefined
  }

  return normalizedDisplayName
}

function resolveSearchSenderUsernameFallback(value?: string | null): string | undefined {
  const normalized = normalizeSearchIdentityText(value)
  if (!normalized || isWxidLikeSearchIdentity(normalized)) {
    return undefined
  }
  return normalized
}

function buildSearchIdentityCandidates(value?: string | null): string[] {
  const normalized = normalizeSearchIdentityText(value)
  if (!normalized) return []
  const lower = normalized.toLowerCase()
  const candidates = new Set<string>([lower])
  if (lower.startsWith('wxid_')) {
    const match = lower.match(/^(wxid_[^_]+)/i)
    if (match?.[1]) {
      candidates.add(match[1])
    }
  }
  return [...candidates]
}

function isCurrentUserSearchIdentity(
  senderUsername?: string | null,
  myWxid?: string | null
): boolean {
  const senderCandidates = buildSearchIdentityCandidates(senderUsername)
  const selfCandidates = buildSearchIdentityCandidates(myWxid)
  if (senderCandidates.length === 0 || selfCandidates.length === 0) {
    return false
  }

  for (const sender of senderCandidates) {
    for (const self of selfCandidates) {
      if (sender === self) return true
      if (sender.startsWith(self + '_')) return true
      if (self.startsWith(sender + '_')) return true
    }
  }
  return false
}

interface XmlField {
  key: string;
  value: string;
  type: 'attr' | 'node';
  tagName?: string;
  path: string;
}

interface BatchImageDecryptCandidate {
  imageMd5?: string
  imageDatName?: string
  createTime?: number
}

// 尝试解析 XML 为可编辑字段
function parseXmlToFields(xml: string): XmlField[] {
  const fields: XmlField[] = []
  if (!xml || !xml.includes('<')) return []
  try {
    const parser = new DOMParser()
    // 包装一下确保是单一根节点
    const wrappedXml = xml.trim().startsWith('<?xml') ? xml : `<root>${xml}</root>`
    const doc = parser.parseFromString(wrappedXml, 'text/xml')
    const errorNode = doc.querySelector('parsererror')
    if (errorNode) return []

    const walk = (node: Node, path: string = '') => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element
        if (element.tagName === 'root') {
          node.childNodes.forEach((child, index) => walk(child, path))
          return
        }

        const currentPath = path ? `${path} > ${element.tagName}` : element.tagName

        for (let i = 0; i < element.attributes.length; i++) {
          const attr = element.attributes[i]
          fields.push({
            key: attr.name,
            value: attr.value,
            type: 'attr',
            tagName: element.tagName,
            path: `${currentPath}[@${attr.name}]`
          })
        }

        if (element.childNodes.length === 1 && element.childNodes[0].nodeType === Node.TEXT_NODE) {
          const text = element.textContent?.trim() || ''
          if (text) {
            fields.push({
              key: element.tagName,
              value: text,
              type: 'node',
              path: currentPath
            })
          }
        } else {
          node.childNodes.forEach((child, index) => walk(child, `${currentPath}[${index}]`))
        }
      }
    }
    doc.childNodes.forEach((node, index) => walk(node, ''))
  } catch (e) {
    console.warn('[XML Parse] Failed:', e)
  }
  return fields
}

// 将编辑后的字段同步回 XML
function updateXmlWithFields(xml: string, fields: XmlField[]): string {
  try {
    const parser = new DOMParser()
    const wrappedXml = xml.trim().startsWith('<?xml') ? xml : `<root>${xml}</root>`
    const doc = parser.parseFromString(wrappedXml, 'text/xml')
    const errorNode = doc.querySelector('parsererror')
    if (errorNode) return xml

    fields.forEach(f => {
      if (f.type === 'attr') {
        const elements = doc.getElementsByTagName(f.tagName!)
        if (elements.length > 0) {
          elements[0].setAttribute(f.key, f.value)
        }
      } else {
        const elements = doc.getElementsByTagName(f.key)
        if (elements.length > 0 && (elements[0].childNodes.length <= 1)) {
          elements[0].textContent = f.value
        }
      }
    })

    let result = new XMLSerializer().serializeToString(doc)
    if (!xml.trim().startsWith('<?xml')) {
      result = result.replace('<root>', '').replace('</root>', '').replace('<root/>', '')
    }
    return result
  } catch (e) {
    return xml
  }
}

// 判断是否为系统消息
function isSystemMessage(localType: number): boolean {
  return SYSTEM_MESSAGE_TYPES.includes(localType)
}

// 格式化文件大小
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

// 清理消息内容的辅助函数
function cleanMessageContent(content: string): string {
  if (!content) return ''
  return content.trim()
}

const CHAT_SESSION_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CHAT_SESSION_PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CHAT_SESSION_PREVIEW_LIMIT_PER_SESSION = 30
const CHAT_SESSION_PREVIEW_MAX_SESSIONS = 18
const CHAT_SESSION_WINDOW_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const CHAT_SESSION_WINDOW_CACHE_MAX_SESSIONS = 30
const CHAT_SESSION_WINDOW_CACHE_MAX_MESSAGES = 300
const GROUP_MEMBERS_PANEL_CACHE_TTL_MS = 10 * 60 * 1000
const SESSION_CONTACT_PROFILE_RETRY_INTERVAL_MS = 15 * 1000
const SESSION_CONTACT_PROFILE_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000

function buildChatSessionListCacheKey(scope: string): string {
  return `weflow.chat.sessions.v1::${scope || 'default'}`
}

function buildChatSessionPreviewCacheKey(scope: string): string {
  return `weflow.chat.preview.v1::${scope || 'default'}`
}

function normalizeChatCacheScope(dbPath: unknown, wxid: unknown): string {
  const db = String(dbPath || '').trim()
  const id = String(wxid || '').trim()
  if (!db && !id) return 'default'
  return `${db}::${id}`
}

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function formatYmdDateFromSeconds(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp * 1000)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatYmdHmDateTime(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  const h = `${d.getHours()}`.padStart(2, '0')
  const min = `${d.getMinutes()}`.padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

interface ChatPageProps {
  standaloneSessionWindow?: boolean
  initialSessionId?: string | null
  standaloneSource?: string | null
  standaloneInitialDisplayName?: string | null
  standaloneInitialAvatarUrl?: string | null
  standaloneInitialContactType?: string | null
}

type StandaloneLoadStage = 'idle' | 'connecting' | 'loading' | 'ready'

interface SessionDetail {
  wxid: string
  displayName: string
  remark?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  messageCount: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  transferMessages?: number
  redPacketMessages?: number
  callMessages?: number
  privateMutualGroups?: number
  groupMemberCount?: number
  groupMyMessages?: number
  groupActiveSpeakers?: number
  groupMutualFriends?: number
  relationStatsLoaded?: boolean
  statsUpdatedAt?: number
  statsStale?: boolean
  firstMessageTime?: number
  latestMessageTime?: number
  messageTables: { dbName: string; tableName: string; count: number }[]
}

interface SessionExportMetric {
  totalMessages: number
  voiceMessages: number
  imageMessages: number
  videoMessages: number
  emojiMessages: number
  transferMessages: number
  redPacketMessages: number
  callMessages: number
  firstTimestamp?: number
  lastTimestamp?: number
  privateMutualGroups?: number
  groupMemberCount?: number
  groupMyMessages?: number
  groupActiveSpeakers?: number
  groupMutualFriends?: number
}

interface SessionExportCacheMeta {
  updatedAt: number
  stale: boolean
  includeRelations: boolean
  source: 'memory' | 'disk' | 'fresh'
}

interface SessionContactProfile {
  displayName?: string
  avatarUrl?: string
  alias?: string
  updatedAt: number
}

type GroupMessageCountStatus = 'loading' | 'ready' | 'failed'

interface GroupPanelMember {
  username: string
  displayName: string
  avatarUrl?: string
  nickname?: string
  alias?: string
  remark?: string
  groupNickname?: string
  isOwner?: boolean
  isFriend: boolean
  messageCount: number
  messageCountStatus: GroupMessageCountStatus
}

const QUOTED_SENDER_CACHE_TTL_MS = 10 * 60 * 1000
const quotedSenderDisplayCache = new Map<string, { displayName: string; updatedAt: number }>()
const quotedSenderDisplayLoading = new Map<string, Promise<string | undefined>>()
const quotedGroupMembersCache = new Map<string, { members: GroupPanelMember[]; updatedAt: number }>()
const quotedGroupMembersLoading = new Map<string, Promise<GroupPanelMember[]>>()

function buildQuotedSenderCacheKey(
  sessionId: string,
  senderUsername: string,
  isGroupChat: boolean
): string {
  const normalizedSessionId = normalizeSearchIdentityText(sessionId) || String(sessionId || '').trim()
  const normalizedSender = normalizeSearchIdentityText(senderUsername) || String(senderUsername || '').trim()
  return `${isGroupChat ? 'group' : 'direct'}::${normalizedSessionId}::${normalizedSender}`
}

function isSameQuotedSenderIdentity(left?: string | null, right?: string | null): boolean {
  const leftCandidates = buildSearchIdentityCandidates(left)
  const rightCandidates = buildSearchIdentityCandidates(right)
  if (leftCandidates.length === 0 || rightCandidates.length === 0) {
    return false
  }

  for (const leftCandidate of leftCandidates) {
    for (const rightCandidate of rightCandidates) {
      if (leftCandidate === rightCandidate) return true
      if (leftCandidate.startsWith(rightCandidate + '_')) return true
      if (rightCandidate.startsWith(leftCandidate + '_')) return true
    }
  }

  return false
}

function normalizeQuotedGroupMember(member: Partial<GroupPanelMember> | null | undefined): GroupPanelMember | null {
  const username = String(member?.username || '').trim()
  if (!username) return null

  const displayName = String(member?.displayName || '').trim()
  const nickname = String(member?.nickname || '').trim()
  const remark = String(member?.remark || '').trim()
  const alias = String(member?.alias || '').trim()
  const groupNickname = String(member?.groupNickname || '').trim()

  return {
    username,
    displayName: displayName || groupNickname || remark || nickname || alias || username,
    avatarUrl: member?.avatarUrl,
    nickname,
    alias,
    remark,
    groupNickname,
    isOwner: Boolean(member?.isOwner),
    isFriend: Boolean(member?.isFriend),
    messageCount: Number.isFinite(member?.messageCount) ? Math.max(0, Math.floor(member?.messageCount as number)) : 0,
    messageCountStatus: 'ready'
  }
}

function resolveQuotedSenderFallbackDisplayName(
  sessionId: string,
  senderUsername?: string | null,
  fallbackDisplayName?: string | null
): string | undefined {
  const resolved = resolveSearchSenderDisplayName(fallbackDisplayName, senderUsername, sessionId)
  if (resolved) return resolved
  return resolveSearchSenderUsernameFallback(senderUsername)
}

function resolveQuotedSenderUsername(
  fromusr?: string | null,
  chatusr?: string | null
): string {
  const normalizedChatUsr = String(chatusr || '').trim()
  const normalizedFromUsr = String(fromusr || '').trim()

  if (normalizedChatUsr) {
    return normalizedChatUsr
  }

  if (normalizedFromUsr.endsWith('@chatroom')) {
    return ''
  }

  return normalizedFromUsr
}

function resolveQuotedGroupMemberDisplayName(member: GroupPanelMember): string | undefined {
  const remark = normalizeSearchIdentityText(member.remark)
  if (remark) return remark

  const groupNickname = normalizeSearchIdentityText(member.groupNickname)
  if (groupNickname) return groupNickname

  const nickname = normalizeSearchIdentityText(member.nickname)
  if (nickname) return nickname

  const displayName = resolveSearchSenderDisplayName(member.displayName, member.username)
  if (displayName) return displayName

  const alias = normalizeSearchIdentityText(member.alias)
  if (alias) return alias

  return resolveSearchSenderUsernameFallback(member.username)
}

function resolveQuotedPrivateDisplayName(contact: any): string | undefined {
  const remark = normalizeSearchIdentityText(contact?.remark)
  if (remark) return remark

  const nickname = normalizeSearchIdentityText(
    contact?.nickName || contact?.nick_name || contact?.nickname
  )
  if (nickname) return nickname

  const alias = normalizeSearchIdentityText(contact?.alias)
  if (alias) return alias

  return undefined
}

async function getQuotedGroupMembers(chatroomId: string): Promise<GroupPanelMember[]> {
  const normalizedChatroomId = String(chatroomId || '').trim()
  if (!normalizedChatroomId || !normalizedChatroomId.includes('@chatroom')) {
    return []
  }

  const cached = quotedGroupMembersCache.get(normalizedChatroomId)
  if (cached && Date.now() - cached.updatedAt < QUOTED_SENDER_CACHE_TTL_MS) {
    return cached.members
  }

  const pending = quotedGroupMembersLoading.get(normalizedChatroomId)
  if (pending) return pending

  const request = window.electronAPI.groupAnalytics.getGroupMembersPanelData(
    normalizedChatroomId,
    { forceRefresh: false, includeMessageCounts: false }
  ).then((result) => {
    const members = Array.isArray(result.data)
      ? result.data
        .map((member) => normalizeQuotedGroupMember(member as Partial<GroupPanelMember>))
        .filter((member): member is GroupPanelMember => Boolean(member))
      : []

    if (members.length > 0) {
      quotedGroupMembersCache.set(normalizedChatroomId, {
        members,
        updatedAt: Date.now()
      })
      return members
    }

    return cached?.members || []
  }).catch(() => cached?.members || []).finally(() => {
    quotedGroupMembersLoading.delete(normalizedChatroomId)
  })

  quotedGroupMembersLoading.set(normalizedChatroomId, request)
  return request
}

async function resolveQuotedSenderDisplayName(options: {
  sessionId: string
  senderUsername?: string | null
  fallbackDisplayName?: string | null
  isGroupChat?: boolean
  myWxid?: string | null
}): Promise<string | undefined> {
  const normalizedSessionId = String(options.sessionId || '').trim()
  const normalizedSender = String(options.senderUsername || '').trim()
  const fallbackDisplayName = resolveQuotedSenderFallbackDisplayName(
    normalizedSessionId,
    normalizedSender,
    options.fallbackDisplayName
  )

  if (!normalizedSender) {
    return fallbackDisplayName
  }

  const cacheKey = buildQuotedSenderCacheKey(normalizedSessionId, normalizedSender, Boolean(options.isGroupChat))
  const cached = quotedSenderDisplayCache.get(cacheKey)
  if (cached && Date.now() - cached.updatedAt < QUOTED_SENDER_CACHE_TTL_MS) {
    return cached.displayName
  }

  const pending = quotedSenderDisplayLoading.get(cacheKey)
  if (pending) return pending

  const request = (async (): Promise<string | undefined> => {
    if (options.isGroupChat) {
      const members = await getQuotedGroupMembers(normalizedSessionId)
      const matchedMember = members.find((member) => isSameQuotedSenderIdentity(member.username, normalizedSender))
      const groupDisplayName = matchedMember ? resolveQuotedGroupMemberDisplayName(matchedMember) : undefined
      if (groupDisplayName) {
        quotedSenderDisplayCache.set(cacheKey, {
          displayName: groupDisplayName,
          updatedAt: Date.now()
        })
        return groupDisplayName
      }
    }

    if (isCurrentUserSearchIdentity(normalizedSender, options.myWxid)) {
      const selfDisplayName = fallbackDisplayName || '我'
      quotedSenderDisplayCache.set(cacheKey, {
        displayName: selfDisplayName,
        updatedAt: Date.now()
      })
      return selfDisplayName
    }

    try {
      const contact = await window.electronAPI.chat.getContact(normalizedSender)
      const contactDisplayName = resolveQuotedPrivateDisplayName(contact)
      if (contactDisplayName) {
        quotedSenderDisplayCache.set(cacheKey, {
          displayName: contactDisplayName,
          updatedAt: Date.now()
        })
        return contactDisplayName
      }
    } catch {
      // ignore contact lookup failures and fall back below
    }

    try {
      const profile = await window.electronAPI.chat.getContactAvatar(normalizedSender)
      const profileDisplayName = normalizeSearchIdentityText(profile?.displayName)
      if (profileDisplayName && !isWxidLikeSearchIdentity(profileDisplayName)) {
        quotedSenderDisplayCache.set(cacheKey, {
          displayName: profileDisplayName,
          updatedAt: Date.now()
        })
        return profileDisplayName
      }
    } catch {
      // ignore avatar lookup failures and keep fallback usable
    }

    if (fallbackDisplayName) {
      quotedSenderDisplayCache.set(cacheKey, {
        displayName: fallbackDisplayName,
        updatedAt: Date.now()
      })
    }

    return fallbackDisplayName
  })().finally(() => {
    quotedSenderDisplayLoading.delete(cacheKey)
  })

  quotedSenderDisplayLoading.set(cacheKey, request)
  return request
}

interface SessionListCachePayload {
  updatedAt: number
  sessions: ChatSession[]
}

interface SessionPreviewCacheEntry {
  updatedAt: number
  messages: Message[]
}

interface SessionPreviewCachePayload {
  updatedAt: number
  entries: Record<string, SessionPreviewCacheEntry>
}

interface GroupMembersPanelCacheEntry {
  updatedAt: number
  members: GroupPanelMember[]
  includeMessageCounts: boolean
}

interface SessionWindowCacheEntry {
  updatedAt: number
  messages: Message[]
  currentOffset: number
  hasMoreMessages: boolean
  hasMoreLater: boolean
  jumpStartTime: number
  jumpEndTime: number
}

interface LoadMessagesOptions {
  preferLatestPath?: boolean
  deferGroupSenderWarmup?: boolean
  forceInitialLimit?: number
  switchRequestSeq?: number
  inSessionJumpRequestSeq?: number
}

// 全局头像加载队列管理器已移至 src/utils/AvatarLoadQueue.ts
import { avatarLoadQueue } from '../utils/AvatarLoadQueue'
import { Avatar } from '../components/Avatar'

// 头像组件 - 支持骨架屏加载和懒加载（优化：限制并发，使用 memo 避免不必要的重渲染）
// 高亮搜索关键词组件
const HighlightText = React.memo(({ text, keyword }: { text: string; keyword: string }) => {
  if (!keyword) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerKeyword = keyword.toLowerCase()
  const matchIndex = lowerText.indexOf(lowerKeyword)

  if (matchIndex === -1) return <>{text}</>

  // 如果匹配位置在后面且文本过长，截断前面部分
  const maxLength = 50
  let displayText = text

  if (text.length > maxLength && matchIndex > 20) {
    const start = Math.max(0, matchIndex - 15)
    displayText = '...' + text.slice(start)
  }

  const parts = displayText.split(new RegExp(`(${keyword})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === lowerKeyword ?
          <span key={i} className="highlight">{part}</span> : part
      )}
    </>
  )
})

const HighlightTextNoTruncate = React.memo(({ text, keyword }: { text: string; keyword: string }) => {
  if (!keyword) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerKeyword = keyword.toLowerCase()
  const matchIndex = lowerText.indexOf(lowerKeyword)

  if (matchIndex === -1) return <>{text}</>

  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matchEnd = matchIndex + keyword.length
  const maxDisplayLength = 25

  // 如果匹配位置不在开头，或文本过长，则居中显示
  if (matchIndex > 5 || text.length > maxDisplayLength) {
    const start = Math.max(0, matchIndex - 8)
    const end = Math.min(text.length, matchEnd + 15)
    const prefix = start > 0 ? '...' : ''
    const suffix = end < text.length ? '...' : ''
    const middleText = text.slice(start, end)

    const parts = middleText.split(new RegExp(`(${escapedKeyword})`, 'gi'))
    return (
      <>
        {prefix}
        {parts.map((part, i) =>
          part.toLowerCase() === lowerKeyword ?
            <span key={i} className="highlight">{part}</span> : part
        )}
        {suffix}
      </>
    )
  }

  const parts = text.split(new RegExp(`(${escapedKeyword})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === lowerKeyword ?
          <span key={i} className="highlight">{part}</span> : part
      )}
    </>
  )
})

// 会话项组件（使用 memo 优化，避免不必要的重渲染）
const SessionItem = React.memo(function SessionItem({
  session,
  isActive,
  onSelect,
  formatTime,
  searchKeyword
}: {
  session: ChatSession
  isActive: boolean
  onSelect: (session: ChatSession) => void
  formatTime: (timestamp: number) => string
  searchKeyword?: string
}) {
  const timeText = useMemo(() =>
    formatTime(session.lastTimestamp || session.sortTimestamp),
    [formatTime, session.lastTimestamp, session.sortTimestamp]
  )

  const isFoldEntry = session.username.toLowerCase().includes('placeholder_foldgroup')
  const isBizEntry = session.username === OFFICIAL_ACCOUNTS_VIRTUAL_ID

  // 折叠入口：专属名称和图标
  if (isFoldEntry) {
    return (
      <div
        className={`session-item fold-entry ${isActive ? 'active' : ''}`}
        onClick={() => onSelect(session)}
      >
        <div className="fold-entry-avatar">
          <MessageSquare size={22} />
        </div>
        <div className="session-info">
          <div className="session-top">
            <span className="session-name">折叠的聊天</span>
            <span className="session-time">{timeText}</span>
          </div>
          <div className="session-bottom">
            <span className="session-summary">{session.summary || '暂无消息'}</span>
          </div>
        </div>
      </div>
    )
  }

  // 公众号入口：专属名称和图标
  if (isBizEntry) {
    return (
      <div
        className={`session-item biz-entry ${isActive ? 'active' : ''}`}
        onClick={() => onSelect(session)}
      >
        <div className="biz-entry-avatar">
          <Newspaper size={22} />
        </div>
        <div className="session-info">
          <div className="session-top">
            <span className="session-name">订阅号/服务号</span>
            <span className="session-time">{timeText}</span>
          </div>
          <div className="session-bottom">
            <span className="session-summary">{session.summary || '查看公众号历史消息'}</span>
          </div>
        </div>
      </div>
    )
  }

  // 根据匹配字段显示不同的 summary
  const summaryContent = useMemo(() => {
    if (session.matchedField === 'wxid') {
      return <span className="session-summary">wxid：<HighlightTextNoTruncate text={session.username} keyword={searchKeyword || ''} /></span>
    } else if (session.matchedField === 'alias' && session.alias) {
      return <span className="session-summary">微信号：<HighlightTextNoTruncate text={session.alias} keyword={searchKeyword || ''} /></span>
    }
    return <span className="session-summary">{session.summary || '暂无消息'}</span>
  }, [session.matchedField, session.username, session.alias, session.summary, searchKeyword])

  return (
    <div
      className={`session-item ${isActive ? 'active' : ''} ${session.isMuted ? 'muted' : ''}`}
      onClick={() => onSelect(session)}
    >
      <Avatar
        src={session.avatarUrl}
        name={session.displayName || session.username}
        size={48}
        className={session.username.includes('@chatroom') ? 'group' : ''}
      />
      <div className="session-info">
        <div className="session-top">
          <span className="session-name">
            {(() => {
              const shouldHighlight = (session.matchedField as any) === 'name' && searchKeyword
              return shouldHighlight ? (
                <HighlightText text={session.displayName || session.username} keyword={searchKeyword} />
              ) : (
                session.displayName || session.username
              )
            })()}
          </span>
          <span className="session-time">{timeText}</span>
        </div>
        <div className="session-bottom">
          {summaryContent}
          <div className="session-badges">
            {session.isMuted && <BellOff size={12} className="mute-icon" />}
            {session.unreadCount > 0 && (
              <span className={`unread-badge ${session.isMuted ? 'muted' : ''}`}>
                {session.unreadCount > 99 ? '99+' : session.unreadCount}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  return (
    prevProps.session.username === nextProps.session.username &&
    prevProps.session.displayName === nextProps.session.displayName &&
    prevProps.session.avatarUrl === nextProps.session.avatarUrl &&
    prevProps.session.summary === nextProps.session.summary &&
    prevProps.session.matchedField === nextProps.session.matchedField &&
    prevProps.session.alias === nextProps.session.alias &&
    prevProps.session.unreadCount === nextProps.session.unreadCount &&
    prevProps.session.lastTimestamp === nextProps.session.lastTimestamp &&
    prevProps.session.sortTimestamp === nextProps.session.sortTimestamp &&
    prevProps.session.isMuted === nextProps.session.isMuted &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.searchKeyword === nextProps.searchKeyword
  )
})



function ChatPage(props: ChatPageProps) {
  const {
    standaloneSessionWindow = false,
    initialSessionId = null,
    standaloneSource = null,
    standaloneInitialDisplayName = null,
    standaloneInitialAvatarUrl = null,
    standaloneInitialContactType = null
  } = props
  const normalizedInitialSessionId = useMemo(() => String(initialSessionId || '').trim(), [initialSessionId])
  const normalizedStandaloneSource = useMemo(() => String(standaloneSource || '').trim().toLowerCase(), [standaloneSource])
  const normalizedStandaloneInitialDisplayName = useMemo(() => String(standaloneInitialDisplayName || '').trim(), [standaloneInitialDisplayName])
  const normalizedStandaloneInitialAvatarUrl = useMemo(() => String(standaloneInitialAvatarUrl || '').trim(), [standaloneInitialAvatarUrl])
  const normalizedStandaloneInitialContactType = useMemo(() => String(standaloneInitialContactType || '').trim().toLowerCase(), [standaloneInitialContactType])
  const shouldHideStandaloneDetailButton = standaloneSessionWindow && normalizedStandaloneSource === 'export'
  const navigate = useNavigate()

  const {
    isConnected,
    isConnecting,
    connectionError,
    sessions,
    currentSessionId,
    isLoadingSessions,
    messages,
    isLoadingMessages,
    isLoadingMore,
    hasMoreMessages,
    searchKeyword,
    setConnected,
    setConnecting,
    setConnectionError,
    setSessions,
    setCurrentSession,
    setLoadingSessions,
    setMessages,
    appendMessages,
    setLoadingMessages,
    setLoadingMore,
    setHasMoreMessages,
    hasMoreLater,
    setHasMoreLater,
    setSearchKeyword
  } = useChatStore(useShallow((state) => ({
    isConnected: state.isConnected,
    isConnecting: state.isConnecting,
    connectionError: state.connectionError,
    sessions: state.sessions,
    currentSessionId: state.currentSessionId,
    isLoadingSessions: state.isLoadingSessions,
    messages: state.messages,
    isLoadingMessages: state.isLoadingMessages,
    isLoadingMore: state.isLoadingMore,
    hasMoreMessages: state.hasMoreMessages,
    searchKeyword: state.searchKeyword,
    setConnected: state.setConnected,
    setConnecting: state.setConnecting,
    setConnectionError: state.setConnectionError,
    setSessions: state.setSessions,
    setCurrentSession: state.setCurrentSession,
    setLoadingSessions: state.setLoadingSessions,
    setMessages: state.setMessages,
    appendMessages: state.appendMessages,
    setLoadingMessages: state.setLoadingMessages,
    setLoadingMore: state.setLoadingMore,
    setHasMoreMessages: state.setHasMoreMessages,
    hasMoreLater: state.hasMoreLater,
    setHasMoreLater: state.setHasMoreLater,
    setSearchKeyword: state.setSearchKeyword
  })))

  const messageListRef = useRef<HTMLDivElement>(null)
  const [messageListScrollParent, setMessageListScrollParent] = useState<HTMLDivElement | null>(null)
  const messageVirtuosoRef = useRef<VirtuosoHandle | null>(null)
  const visibleMessageRangeRef = useRef<{ startIndex: number; endIndex: number }>({ startIndex: 0, endIndex: 0 })
  const topRangeLoadLockRef = useRef(false)
  const bottomRangeLoadLockRef = useRef(false)
  const topRangeLoadLastTriggerAtRef = useRef(0)
  const suppressAutoLoadLaterRef = useRef(false)
  const suppressAutoScrollOnNextMessageGrowthRef = useRef(false)
  const prependingHistoryRef = useRef(false)
  const isMessageListScrollingRef = useRef(false)
  const messageListScrollTimeoutRef = useRef<number | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const handleMessageListScrollParentRef = useCallback((node: HTMLDivElement | null) => {
    messageListRef.current = node
    setMessageListScrollParent(node)
  }, [])

  const getMessageKey = useCallback((msg: Message): string => {
    if (msg.messageKey) return msg.messageKey
    return `fallback:${msg.serverId || 0}:${msg.createTime}:${msg.sortSeq || 0}:${msg.localId || 0}:${msg.senderUsername || ''}:${msg.localType || 0}`
  }, [])
  const initialRevealTimerRef = useRef<number | null>(null)
  const sessionListRef = useRef<HTMLDivElement>(null)
  const jumpCalendarWrapRef = useRef<HTMLDivElement>(null)
  const jumpPopoverPortalRef = useRef<HTMLDivElement>(null)
  const [currentOffset, setCurrentOffset] = useState(0)
  const [jumpStartTime, setJumpStartTime] = useState(0)
  const [jumpEndTime, setJumpEndTime] = useState(0)
  const [showJumpPopover, setShowJumpPopover] = useState(false)
  const [jumpPopoverDate, setJumpPopoverDate] = useState<Date>(new Date())
  const [jumpPopoverPosition, setJumpPopoverPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const isDateJumpRef = useRef(false)
  const [messageDates, setMessageDates] = useState<Set<string>>(new Set())
  const [hasLoadedMessageDates, setHasLoadedMessageDates] = useState(false)
  const [loadingDates, setLoadingDates] = useState(false)
  const messageDatesCache = useRef<Map<string, Set<string>>>(new Map())
  const [messageDateCounts, setMessageDateCounts] = useState<Record<string, number>>({})
  const [loadingDateCounts, setLoadingDateCounts] = useState(false)
  const messageDateCountsCache = useRef<Map<string, Record<string, number>>>(new Map())
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | undefined>(undefined)
  const [myWxid, setMyWxid] = useState<string | undefined>(undefined)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [isResizing, setIsResizing] = useState(false)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [showGroupMembersPanel, setShowGroupMembersPanel] = useState(false)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [isLoadingDetailExtra, setIsLoadingDetailExtra] = useState(false)
  const [isRefreshingDetailStats, setIsRefreshingDetailStats] = useState(false)
  const [isLoadingRelationStats, setIsLoadingRelationStats] = useState(false)
  const [groupPanelMembers, setGroupPanelMembers] = useState<GroupPanelMember[]>([])
  const [isLoadingGroupMembers, setIsLoadingGroupMembers] = useState(false)
  const [groupMembersError, setGroupMembersError] = useState<string | null>(null)
  const [groupMembersLoadingHint, setGroupMembersLoadingHint] = useState('')
  const [isRefreshingGroupMembers, setIsRefreshingGroupMembers] = useState(false)
  const [groupMemberSearchKeyword, setGroupMemberSearchKeyword] = useState('')
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [highlightedMessageKeys, setHighlightedMessageKeys] = useState<string[]>([])
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false)
  const [foldedView, setFoldedView] = useState(false) // 是否在"折叠的群聊"视图
  const [bizView, setBizView] = useState(false) // 是否在"公众号"视图
  const [selectedBizAccount, setSelectedBizAccount] = useState<BizAccount | null>(null)
  const [hasInitialMessages, setHasInitialMessages] = useState(false)
  const [isSessionSwitching, setIsSessionSwitching] = useState(false)
  const [noMessageTable, setNoMessageTable] = useState(false)
  const [fallbackDisplayName, setFallbackDisplayName] = useState<string | null>(normalizedStandaloneInitialDisplayName || null)
  const [fallbackAvatarUrl, setFallbackAvatarUrl] = useState<string | null>(normalizedStandaloneInitialAvatarUrl || null)
  const [standaloneLoadStage, setStandaloneLoadStage] = useState<StandaloneLoadStage>(
    standaloneSessionWindow && normalizedInitialSessionId ? 'connecting' : 'idle'
  )
  const [standaloneInitialLoadRequested, setStandaloneInitialLoadRequested] = useState(false)
  const [showVoiceTranscribeDialog, setShowVoiceTranscribeDialog] = useState(false)
  const [autoTranscribeVoiceEnabled, setAutoTranscribeVoiceEnabled] = useState(false)
  const [pendingVoiceTranscriptRequest, setPendingVoiceTranscriptRequest] = useState<{ sessionId: string; messageId: string } | null>(null)
  const [inProgressExportSessionIds, setInProgressExportSessionIds] = useState<Set<string>>(new Set())
  const [isPreparingExportDialog, setIsPreparingExportDialog] = useState(false)
  const [chatSnsTimelineTarget, setChatSnsTimelineTarget] = useState<ContactSnsTimelineTarget | null>(null)
  const [exportPrepareHint, setExportPrepareHint] = useState('')

  // 消息右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, message: Message } | null>(null)
  const [showMessageInfo, setShowMessageInfo] = useState<Message | null>(null)
  const [editingMessage, setEditingMessage] = useState<{ message: Message, content: string } | null>(null)

  // 多选模式
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set())

  // 编辑消息额外状态
  const [editMode, setEditMode] = useState<'raw' | 'fields'>('raw')
  const [tempFields, setTempFields] = useState<XmlField[]>([])

  // 批量语音转文字相关状态（进度/结果 由全局 store 管理）
  const {
    isBatchTranscribing,
    runningBatchVoiceTaskType,
    batchTranscribeProgress,
    startTranscribe,
    updateProgress,
    finishTranscribe,
    setShowBatchProgress
  } = useBatchTranscribeStore(useShallow((state) => ({
    isBatchTranscribing: state.isBatchTranscribing,
    runningBatchVoiceTaskType: state.taskType,
    batchTranscribeProgress: state.progress,
    startTranscribe: state.startTranscribe,
    updateProgress: state.updateProgress,
    finishTranscribe: state.finishTranscribe,
    setShowBatchProgress: state.setShowToast
  })))
  const {
    isBatchDecrypting,
    batchDecryptProgress,
    startDecrypt,
    updateDecryptProgress,
    finishDecrypt,
    setShowBatchDecryptToast
  } = useBatchImageDecryptStore(useShallow((state) => ({
    isBatchDecrypting: state.isBatchDecrypting,
    batchDecryptProgress: state.progress,
    startDecrypt: state.startDecrypt,
    updateDecryptProgress: state.updateProgress,
    finishDecrypt: state.finishDecrypt,
    setShowBatchDecryptToast: state.setShowToast
  })))
  const [showBatchConfirm, setShowBatchConfirm] = useState(false)
  const [batchVoiceCount, setBatchVoiceCount] = useState(0)
  const [batchVoiceMessages, setBatchVoiceMessages] = useState<Message[] | null>(null)
  const [batchVoiceDates, setBatchVoiceDates] = useState<string[]>([])
  const [batchSelectedDates, setBatchSelectedDates] = useState<Set<string>>(new Set())
  const [batchVoiceTaskType, setBatchVoiceTaskType] = useState<BatchVoiceTaskType>('transcribe')
  const [showBatchDecryptConfirm, setShowBatchDecryptConfirm] = useState(false)
  const [batchImageMessages, setBatchImageMessages] = useState<BatchImageDecryptCandidate[] | null>(null)
  const [batchImageDates, setBatchImageDates] = useState<string[]>([])
  const [batchImageSelectedDates, setBatchImageSelectedDates] = useState<Set<string>>(new Set())
  const [batchDecryptConcurrency, setBatchDecryptConcurrency] = useState(6)
  const [showConcurrencyDropdown, setShowConcurrencyDropdown] = useState(false)

  // 批量删除相关状态
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState({ current: 0, total: 0 })
  const [cancelDeleteRequested, setCancelDeleteRequested] = useState(false)
  // 会话内搜索
  const [showInSessionSearch, setShowInSessionSearch] = useState(false)
  const [inSessionQuery, setInSessionQuery] = useState('')
  const [inSessionResults, setInSessionResults] = useState<Message[]>([])
  const [inSessionSearching, setInSessionSearching] = useState(false)
  const [inSessionEnriching, setInSessionEnriching] = useState(false)
  const [inSessionSearchError, setInSessionSearchError] = useState<string | null>(null)
  const inSessionSearchRef = useRef<HTMLInputElement>(null)
  const inSessionResultJumpTimerRef = useRef<number | null>(null)
  const inSessionResultJumpRequestSeqRef = useRef(0)
  // 全局消息搜索
  const [showGlobalMsgSearch, setShowGlobalMsgSearch] = useState(false)
  const [globalMsgQuery, setGlobalMsgQuery] = useState('')
  const [globalMsgResults, setGlobalMsgResults] = useState<GlobalMsgSearchResult[]>([])
  const [globalMsgSearching, setGlobalMsgSearching] = useState(false)
  const [globalMsgSearchPhase, setGlobalMsgSearchPhase] = useState<GlobalMsgSearchPhase>('idle')
  const [globalMsgIsBackfilling, setGlobalMsgIsBackfilling] = useState(false)
  const [globalMsgAuthoritativeSessionCount, setGlobalMsgAuthoritativeSessionCount] = useState(0)
  const [globalMsgSearchError, setGlobalMsgSearchError] = useState<string | null>(null)
  const pendingInSessionSearchRef = useRef<PendingInSessionSearchPayload | null>(null)
  const pendingGlobalMsgSearchReplayRef = useRef<string | null>(null)
  const globalMsgPrefixCacheRef = useRef<GlobalMsgPrefixCacheEntry | null>(null)

  // 自定义删除确认对话框
  const [deleteConfirm, setDeleteConfirm] = useState<{
    show: boolean;
    mode: 'single' | 'batch';
    message?: Message;
    count?: number;
  }>({ show: false, mode: 'single' })

  // 联系人信息加载控制
  const isEnrichingRef = useRef(false)
  const enrichCancelledRef = useRef(false)
  const isScrollingRef = useRef(false)
  const sessionScrollTimeoutRef = useRef<number | null>(null)
  const pendingSessionContactEnrichRef = useRef<Set<string>>(new Set())
  const sessionContactEnrichAttemptAtRef = useRef<Map<string, number>>(new Map())
  const sessionContactProfileCacheRef = useRef<Map<string, SessionContactProfile>>(new Map())


  const highlightedMessageSet = useMemo(() => new Set(highlightedMessageKeys), [highlightedMessageKeys])
  const messageKeySetRef = useRef<Set<string>>(new Set())
  const lastMessageTimeRef = useRef(0)
  const isMessageListAtBottomRef = useRef(true)
  const lastObservedMessageCountRef = useRef(0)
  const lastVisibleSenderWarmupAtRef = useRef(0)
  const sessionMapRef = useRef<Map<string, ChatSession>>(new Map())
  const sessionsRef = useRef<ChatSession[]>([])
  const currentSessionRef = useRef<string | null>(null)
  const pendingSessionLoadRef = useRef<string | null>(null)
  const sessionSwitchRequestSeqRef = useRef(0)
  const initialLoadRequestedSessionRef = useRef<string | null>(null)
  const prevSessionRef = useRef<string | null>(null)
  const isConnectedRef = useRef(false)
  const isRefreshingRef = useRef(false)
  const searchKeywordRef = useRef('')
  const preloadImageKeysRef = useRef<Set<string>>(new Set())
  const lastPreloadSessionRef = useRef<string | null>(null)
  const detailRequestSeqRef = useRef(0)
  const groupMembersRequestSeqRef = useRef(0)
  const groupMembersPanelCacheRef = useRef<Map<string, GroupMembersPanelCacheEntry>>(new Map())
  const hasInitializedGroupMembersRef = useRef(false)
  const chatCacheScopeRef = useRef('default')
  const previewCacheRef = useRef<Record<string, SessionPreviewCacheEntry>>({})
  const sessionWindowCacheRef = useRef<Map<string, SessionWindowCacheEntry>>(new Map())
  const previewPersistTimerRef = useRef<number | null>(null)
  const sessionListPersistTimerRef = useRef<number | null>(null)
  const scrollBottomButtonArmTimerRef = useRef<number | null>(null)
  const suppressScrollToBottomButtonRef = useRef(false)
  const pendingExportRequestIdRef = useRef<string | null>(null)
  const exportPrepareLongWaitTimerRef = useRef<number | null>(null)
  const jumpDatesRequestSeqRef = useRef(0)
  const jumpDateCountsRequestSeqRef = useRef(0)

  const suppressScrollToBottomButton = useCallback((delayMs = 180) => {
    suppressScrollToBottomButtonRef.current = true
    if (scrollBottomButtonArmTimerRef.current !== null) {
      window.clearTimeout(scrollBottomButtonArmTimerRef.current)
      scrollBottomButtonArmTimerRef.current = null
    }
    scrollBottomButtonArmTimerRef.current = window.setTimeout(() => {
      suppressScrollToBottomButtonRef.current = false
      scrollBottomButtonArmTimerRef.current = null
    }, delayMs)
  }, [])

  const markMessageListScrolling = useCallback(() => {
    isMessageListScrollingRef.current = true
    if (messageListScrollTimeoutRef.current !== null) {
      window.clearTimeout(messageListScrollTimeoutRef.current)
      messageListScrollTimeoutRef.current = null
    }
    messageListScrollTimeoutRef.current = window.setTimeout(() => {
      isMessageListScrollingRef.current = false
      messageListScrollTimeoutRef.current = null
    }, MESSAGE_LIST_SCROLL_IDLE_MS)
  }, [])

  const isGroupChatSession = useCallback((username: string) => {
    return username.includes('@chatroom')
  }, [])

  const mergeSessionContactPresentation = useCallback((session: ChatSession, previousSession?: ChatSession): ChatSession => {
    const username = String(session.username || '').trim()
    if (!username || isFoldPlaceholderSession(username)) {
      return session
    }

    const now = Date.now()
    const cacheMap = sessionContactProfileCacheRef.current
    const cachedProfile = cacheMap.get(username)
    if (cachedProfile && now - cachedProfile.updatedAt > SESSION_CONTACT_PROFILE_CACHE_TTL_MS) {
      cacheMap.delete(username)
    }
    const profile = cacheMap.get(username)

    const sessionDisplayName = resolveSessionDisplayName(session.displayName, username)
    const previousDisplayName = resolveSessionDisplayName(previousSession?.displayName, username)
    const profileDisplayName = resolveSessionDisplayName(profile?.displayName, username)
    const resolvedDisplayName = sessionDisplayName || previousDisplayName || profileDisplayName || session.displayName || username

    const sessionAvatarUrl = normalizeSearchAvatarUrl(session.avatarUrl)
    const previousAvatarUrl = normalizeSearchAvatarUrl(previousSession?.avatarUrl)
    const profileAvatarUrl = normalizeSearchAvatarUrl(profile?.avatarUrl)
    const resolvedAvatarUrl = sessionAvatarUrl || previousAvatarUrl || profileAvatarUrl

    const sessionAlias = normalizeSearchIdentityText(session.alias)
    const previousAlias = normalizeSearchIdentityText(previousSession?.alias)
    const profileAlias = normalizeSearchIdentityText(profile?.alias)
    const resolvedAlias = sessionAlias || previousAlias || profileAlias

    if (
      resolvedDisplayName === session.displayName &&
      resolvedAvatarUrl === session.avatarUrl &&
      resolvedAlias === session.alias
    ) {
      return session
    }

    return {
      ...session,
      displayName: resolvedDisplayName,
      avatarUrl: resolvedAvatarUrl,
      alias: resolvedAlias
    }
  }, [])

  const clearExportPrepareState = useCallback(() => {
    pendingExportRequestIdRef.current = null
    setIsPreparingExportDialog(false)
    setExportPrepareHint('')
    if (exportPrepareLongWaitTimerRef.current) {
      window.clearTimeout(exportPrepareLongWaitTimerRef.current)
      exportPrepareLongWaitTimerRef.current = null
    }
  }, [])

  const resolveCurrentViewDate = useCallback(() => {
    if (jumpStartTime > 0) {
      return new Date(jumpStartTime * 1000)
    }
    const fallbackMessage = messages[messages.length - 1] || messages[0]
    const rawTimestamp = Number(fallbackMessage?.createTime || 0)
    if (Number.isFinite(rawTimestamp) && rawTimestamp > 0) {
      return new Date(rawTimestamp > 10000000000 ? rawTimestamp : rawTimestamp * 1000)
    }
    return new Date()
  }, [jumpStartTime, messages])

  const loadJumpCalendarData = useCallback(async (sessionId: string) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return

    const cachedDates = messageDatesCache.current.get(normalizedSessionId)
    if (cachedDates) {
      setMessageDates(new Set(cachedDates))
      setHasLoadedMessageDates(true)
      setLoadingDates(false)
    } else {
      setLoadingDates(true)
      setHasLoadedMessageDates(false)
      setMessageDates(new Set())
      const requestSeq = jumpDatesRequestSeqRef.current + 1
      jumpDatesRequestSeqRef.current = requestSeq
      try {
        const result = await window.electronAPI.chat.getMessageDates(normalizedSessionId)
        if (requestSeq !== jumpDatesRequestSeqRef.current || currentSessionRef.current !== normalizedSessionId) return
        if (result?.success && Array.isArray(result.dates)) {
          const dateSet = new Set<string>(result.dates)
          messageDatesCache.current.set(normalizedSessionId, dateSet)
          setMessageDates(new Set(dateSet))
          setHasLoadedMessageDates(true)
        }
      } catch (error) {
        console.error('获取消息日期失败:', error)
      } finally {
        if (requestSeq === jumpDatesRequestSeqRef.current && currentSessionRef.current === normalizedSessionId) {
          setLoadingDates(false)
        }
      }
    }

    const cachedCounts = messageDateCountsCache.current.get(normalizedSessionId)
    if (cachedCounts) {
      setMessageDateCounts({ ...cachedCounts })
      setLoadingDateCounts(false)
      return
    }

    setLoadingDateCounts(true)
    setMessageDateCounts({})
    const requestSeq = jumpDateCountsRequestSeqRef.current + 1
    jumpDateCountsRequestSeqRef.current = requestSeq
    try {
      const result = await window.electronAPI.chat.getMessageDateCounts(normalizedSessionId)
      if (requestSeq !== jumpDateCountsRequestSeqRef.current || currentSessionRef.current !== normalizedSessionId) return
      if (result?.success && result.counts) {
        const normalizedCounts: Record<string, number> = {}
        Object.entries(result.counts).forEach(([date, value]) => {
          const count = Number(value)
          if (!date || !Number.isFinite(count) || count <= 0) return
          normalizedCounts[date] = count
        })
        messageDateCountsCache.current.set(normalizedSessionId, normalizedCounts)
        setMessageDateCounts(normalizedCounts)
      }
    } catch (error) {
      console.error('获取每日消息数失败:', error)
    } finally {
      if (requestSeq === jumpDateCountsRequestSeqRef.current && currentSessionRef.current === normalizedSessionId) {
        setLoadingDateCounts(false)
      }
    }
  }, [])

  const updateJumpPopoverPosition = useCallback(() => {
    const anchor = jumpCalendarWrapRef.current
    if (!anchor) return

    const popoverWidth = 312
    const viewportGap = 8
    const anchorRect = anchor.getBoundingClientRect()

    let left = anchorRect.right - popoverWidth
    left = Math.max(viewportGap, Math.min(left, window.innerWidth - popoverWidth - viewportGap))

    const portalHeight = jumpPopoverPortalRef.current?.offsetHeight || 0
    const belowTop = anchorRect.bottom + 10
    let top = belowTop
    if (portalHeight > 0 && belowTop + portalHeight > window.innerHeight - viewportGap) {
      top = Math.max(viewportGap, anchorRect.top - portalHeight - 10)
    }

    setJumpPopoverPosition(prev => {
      if (prev.top === top && prev.left === left) return prev
      return { top, left }
    })
  }, [])

  const handleToggleJumpPopover = useCallback(() => {
    if (!currentSessionId) return
    if (showJumpPopover) {
      setShowJumpPopover(false)
      return
    }
    setJumpPopoverDate(resolveCurrentViewDate())
    updateJumpPopoverPosition()
    setShowJumpPopover(true)
    requestAnimationFrame(() => updateJumpPopoverPosition())
    void loadJumpCalendarData(currentSessionId)
  }, [currentSessionId, loadJumpCalendarData, resolveCurrentViewDate, showJumpPopover, updateJumpPopoverPosition])

  useEffect(() => {
    const unsubscribe = onExportSessionStatus((payload) => {
      const ids = Array.isArray(payload?.inProgressSessionIds)
        ? payload.inProgressSessionIds
          .filter((id): id is string => typeof id === 'string')
          .map(id => id.trim())
          .filter(Boolean)
        : []
      setInProgressExportSessionIds(new Set(ids))
    })

    requestExportSessionStatus()
    const timer = window.setTimeout(() => {
      requestExportSessionStatus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = onSingleExportDialogStatus((payload) => {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : ''
      if (!requestId || requestId !== pendingExportRequestIdRef.current) return

      if (payload.status === 'initializing') {
        setExportPrepareHint('正在准备导出模块（首次会稍慢，通常 1-3 秒）')
        if (exportPrepareLongWaitTimerRef.current) {
          window.clearTimeout(exportPrepareLongWaitTimerRef.current)
        }
        exportPrepareLongWaitTimerRef.current = window.setTimeout(() => {
          if (pendingExportRequestIdRef.current !== requestId) return
          setExportPrepareHint('仍在准备导出模块，请稍候...')
        }, 8000)
        return
      }

      if (payload.status === 'opened') {
        clearExportPrepareState()
        return
      }

      if (payload.status === 'failed') {
        const message = (typeof payload.message === 'string' && payload.message.trim())
          ? payload.message.trim()
          : '导出模块初始化失败，请重试'
        clearExportPrepareState()
        window.alert(message)
      }
    })

    return () => {
      unsubscribe()
      if (exportPrepareLongWaitTimerRef.current) {
        window.clearTimeout(exportPrepareLongWaitTimerRef.current)
        exportPrepareLongWaitTimerRef.current = null
      }
    }
  }, [clearExportPrepareState])

  useEffect(() => {
    if (!isPreparingExportDialog || !currentSessionId) return
    if (!inProgressExportSessionIds.has(currentSessionId)) return
    clearExportPrepareState()
  }, [clearExportPrepareState, currentSessionId, inProgressExportSessionIds, isPreparingExportDialog])

  // 加载当前用户头像
  const loadMyAvatar = useCallback(async () => {
    try {
      const result = await window.electronAPI.chat.getMyAvatarUrl()
      if (result.success && result.avatarUrl) {
        setMyAvatarUrl(result.avatarUrl)
      }
    } catch (e) {
      console.error('加载用户头像失败:', e)
    }
  }, [])

  const resolveChatCacheScope = useCallback(async (): Promise<string> => {
    try {
      const [dbPath, myWxid] = await Promise.all([
        window.electronAPI.config.get('dbPath'),
        window.electronAPI.config.get('myWxid')
      ])
      const scope = normalizeChatCacheScope(dbPath, myWxid)
      chatCacheScopeRef.current = scope
      return scope
    } catch {
      chatCacheScopeRef.current = 'default'
      return 'default'
    }
  }, [])

  const loadPreviewCacheFromStorage = useCallback((scope: string): Record<string, SessionPreviewCacheEntry> => {
    try {
      const cacheKey = buildChatSessionPreviewCacheKey(scope)
      const payload = safeParseJson<SessionPreviewCachePayload>(window.localStorage.getItem(cacheKey))
      if (!payload || typeof payload.updatedAt !== 'number' || !payload.entries) {
        return {}
      }
      if (Date.now() - payload.updatedAt > CHAT_SESSION_PREVIEW_CACHE_TTL_MS) {
        return {}
      }
      return payload.entries
    } catch {
      return {}
    }
  }, [])

  const persistPreviewCacheToStorage = useCallback((scope: string, entries: Record<string, SessionPreviewCacheEntry>) => {
    try {
      const cacheKey = buildChatSessionPreviewCacheKey(scope)
      const payload: SessionPreviewCachePayload = {
        updatedAt: Date.now(),
        entries
      }
      window.localStorage.setItem(cacheKey, JSON.stringify(payload))
    } catch {
      // ignore cache write failures
    }
  }, [])

  const persistSessionPreviewCache = useCallback((sessionId: string, previewMessages: Message[]) => {
    const id = String(sessionId || '').trim()
    if (!id || !Array.isArray(previewMessages) || previewMessages.length === 0) return

    const trimmed = previewMessages.slice(-CHAT_SESSION_PREVIEW_LIMIT_PER_SESSION)
    const currentEntries = { ...previewCacheRef.current }
    currentEntries[id] = {
      updatedAt: Date.now(),
      messages: trimmed
    }

    const sortedIds = Object.entries(currentEntries)
      .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
      .map(([entryId]) => entryId)

    const keptIds = new Set(sortedIds.slice(0, CHAT_SESSION_PREVIEW_MAX_SESSIONS))
    const compactEntries: Record<string, SessionPreviewCacheEntry> = {}
    for (const [entryId, entry] of Object.entries(currentEntries)) {
      if (keptIds.has(entryId)) {
        compactEntries[entryId] = entry
      }
    }

    previewCacheRef.current = compactEntries
    if (previewPersistTimerRef.current !== null) {
      window.clearTimeout(previewPersistTimerRef.current)
    }
    previewPersistTimerRef.current = window.setTimeout(() => {
      persistPreviewCacheToStorage(chatCacheScopeRef.current, previewCacheRef.current)
      previewPersistTimerRef.current = null
    }, 220)
  }, [persistPreviewCacheToStorage])

  const hydrateSessionPreview = useCallback(async (sessionId: string) => {
    const id = String(sessionId || '').trim()
    if (!id) return

    const localEntry = previewCacheRef.current[id]
    if (
      localEntry &&
      Array.isArray(localEntry.messages) &&
      localEntry.messages.length > 0 &&
      Date.now() - localEntry.updatedAt <= CHAT_SESSION_PREVIEW_CACHE_TTL_MS
    ) {
      setMessages(localEntry.messages.slice())
      setHasInitialMessages(true)
      return
    }

    try {
      const result = await window.electronAPI.chat.getCachedMessages(id)
      if (!result.success || !Array.isArray(result.messages) || result.messages.length === 0) {
        return
      }
      if (currentSessionRef.current !== id && pendingSessionLoadRef.current !== id) return
      setMessages(result.messages)
      setHasInitialMessages(true)
      persistSessionPreviewCache(id, result.messages)
    } catch {
      // ignore preview cache errors
    }
  }, [persistSessionPreviewCache, setMessages])

  const saveSessionWindowCache = useCallback((sessionId: string, entry: Omit<SessionWindowCacheEntry, 'updatedAt'>) => {
    const id = String(sessionId || '').trim()
    if (!id || !Array.isArray(entry.messages) || entry.messages.length === 0) return

    const trimmedMessages = entry.messages.length > CHAT_SESSION_WINDOW_CACHE_MAX_MESSAGES
      ? entry.messages.slice(-CHAT_SESSION_WINDOW_CACHE_MAX_MESSAGES)
      : entry.messages.slice()

    const cache = sessionWindowCacheRef.current
    cache.set(id, {
      updatedAt: Date.now(),
      ...entry,
      messages: trimmedMessages,
      currentOffset: trimmedMessages.length
    })

    if (cache.size <= CHAT_SESSION_WINDOW_CACHE_MAX_SESSIONS) return

    const sortedByTime = [...cache.entries()]
      .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))

    for (const [key] of sortedByTime) {
      if (cache.size <= CHAT_SESSION_WINDOW_CACHE_MAX_SESSIONS) break
      cache.delete(key)
    }
  }, [])

  const restoreSessionWindowCache = useCallback((sessionId: string): boolean => {
    const id = String(sessionId || '').trim()
    if (!id) return false

    const cache = sessionWindowCacheRef.current
    const entry = cache.get(id)
    if (!entry) return false
    if (Date.now() - entry.updatedAt > CHAT_SESSION_WINDOW_CACHE_TTL_MS) {
      cache.delete(id)
      return false
    }
    if (!Array.isArray(entry.messages) || entry.messages.length === 0) {
      cache.delete(id)
      return false
    }

    // LRU: 命中后更新时间
    cache.set(id, {
      ...entry,
      updatedAt: Date.now(),
      messages: entry.messages.slice()
    })

    setMessages(entry.messages.slice())
    setCurrentOffset(entry.messages.length)
    setHasMoreMessages(entry.hasMoreMessages !== false)
    setHasMoreLater(entry.hasMoreLater === true)
    setJumpStartTime(entry.jumpStartTime || 0)
    setJumpEndTime(entry.jumpEndTime || 0)
    setNoMessageTable(false)
    setHasInitialMessages(true)
    return true
  }, [
    setMessages,
    setHasMoreMessages,
    setHasMoreLater,
    setCurrentOffset,
    setJumpStartTime,
    setJumpEndTime,
    setNoMessageTable,
    setHasInitialMessages
  ])

  const hydrateSessionListCache = useCallback((scope: string): boolean => {
    try {
      const cacheKey = buildChatSessionListCacheKey(scope)
      const payload = safeParseJson<SessionListCachePayload>(window.localStorage.getItem(cacheKey))
      if (!payload || typeof payload.updatedAt !== 'number' || !Array.isArray(payload.sessions)) {
        previewCacheRef.current = loadPreviewCacheFromStorage(scope)
        return false
      }
      previewCacheRef.current = loadPreviewCacheFromStorage(scope)
      if (Date.now() - payload.updatedAt > CHAT_SESSION_LIST_CACHE_TTL_MS) {
        return false
      }
      if (!Array.isArray(sessionsRef.current) || sessionsRef.current.length === 0) {
        setSessions(payload.sessions)
        sessionsRef.current = payload.sessions
        return payload.sessions.length > 0
      }
      return false
    } catch {
      previewCacheRef.current = loadPreviewCacheFromStorage(scope)
      return false
    }
  }, [loadPreviewCacheFromStorage, setSessions])

  const persistSessionListCache = useCallback((scope: string, nextSessions: ChatSession[]) => {
    try {
      const cacheKey = buildChatSessionListCacheKey(scope)
      const payload: SessionListCachePayload = {
        updatedAt: Date.now(),
        sessions: nextSessions
      }
      window.localStorage.setItem(cacheKey, JSON.stringify(payload))
    } catch {
      // ignore cache write failures
    }
  }, [])

  const applySessionDetailStats = useCallback((
    sessionId: string,
    metric: SessionExportMetric,
    cacheMeta?: SessionExportCacheMeta,
    relationLoadedOverride?: boolean
  ) => {
    setSessionDetail((prev) => {
      if (!prev || prev.wxid !== sessionId) return prev
      const relationLoaded = relationLoadedOverride ?? Boolean(prev.relationStatsLoaded)
      return {
        ...prev,
        messageCount: Number.isFinite(metric.totalMessages) ? metric.totalMessages : prev.messageCount,
        voiceMessages: Number.isFinite(metric.voiceMessages) ? metric.voiceMessages : prev.voiceMessages,
        imageMessages: Number.isFinite(metric.imageMessages) ? metric.imageMessages : prev.imageMessages,
        videoMessages: Number.isFinite(metric.videoMessages) ? metric.videoMessages : prev.videoMessages,
        emojiMessages: Number.isFinite(metric.emojiMessages) ? metric.emojiMessages : prev.emojiMessages,
        transferMessages: Number.isFinite(metric.transferMessages) ? metric.transferMessages : prev.transferMessages,
        redPacketMessages: Number.isFinite(metric.redPacketMessages) ? metric.redPacketMessages : prev.redPacketMessages,
        callMessages: Number.isFinite(metric.callMessages) ? metric.callMessages : prev.callMessages,
        groupMemberCount: Number.isFinite(metric.groupMemberCount) ? metric.groupMemberCount : prev.groupMemberCount,
        groupMyMessages: Number.isFinite(metric.groupMyMessages) ? metric.groupMyMessages : prev.groupMyMessages,
        groupActiveSpeakers: Number.isFinite(metric.groupActiveSpeakers) ? metric.groupActiveSpeakers : prev.groupActiveSpeakers,
        privateMutualGroups: relationLoaded && Number.isFinite(metric.privateMutualGroups)
          ? metric.privateMutualGroups
          : prev.privateMutualGroups,
        groupMutualFriends: relationLoaded && Number.isFinite(metric.groupMutualFriends)
          ? metric.groupMutualFriends
          : prev.groupMutualFriends,
        relationStatsLoaded: relationLoaded,
        statsUpdatedAt: cacheMeta?.updatedAt ?? prev.statsUpdatedAt,
        statsStale: typeof cacheMeta?.stale === 'boolean' ? cacheMeta.stale : prev.statsStale,
        firstMessageTime: Number.isFinite(metric.firstTimestamp) ? metric.firstTimestamp : prev.firstMessageTime,
        latestMessageTime: Number.isFinite(metric.lastTimestamp) ? metric.lastTimestamp : prev.latestMessageTime
      }
    })
  }, [])

  // 加载会话详情
  const loadSessionDetail = useCallback(async (sessionId: string) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return
    const taskId = registerBackgroundTask({
      sourcePage: 'chat',
      title: '聊天页会话详情统计',
      detail: `准备读取 ${sessionMapRef.current.get(normalizedSessionId)?.displayName || normalizedSessionId} 的详情`,
      progressText: '基础信息',
      cancelable: true
    })

    const requestSeq = ++detailRequestSeqRef.current
    const mappedSession = sessionMapRef.current.get(normalizedSessionId) || sessionsRef.current.find((s) => s.username === normalizedSessionId)
    const hintedCount = typeof mappedSession?.messageCountHint === 'number' && Number.isFinite(mappedSession.messageCountHint) && mappedSession.messageCountHint >= 0
      ? Math.floor(mappedSession.messageCountHint)
      : undefined

    setIsRefreshingDetailStats(false)
    setIsLoadingRelationStats(false)
    setSessionDetail((prev) => {
      const sameSession = prev?.wxid === normalizedSessionId
      return {
        wxid: normalizedSessionId,
        displayName: mappedSession?.displayName || prev?.displayName || normalizedSessionId,
        remark: sameSession ? prev?.remark : undefined,
        nickName: sameSession ? prev?.nickName : undefined,
        alias: sameSession ? prev?.alias : undefined,
        avatarUrl: mappedSession?.avatarUrl || (sameSession ? prev?.avatarUrl : undefined),
        messageCount: hintedCount ?? (sameSession ? prev.messageCount : Number.NaN),
        voiceMessages: sameSession ? prev?.voiceMessages : undefined,
        imageMessages: sameSession ? prev?.imageMessages : undefined,
        videoMessages: sameSession ? prev?.videoMessages : undefined,
        emojiMessages: sameSession ? prev?.emojiMessages : undefined,
        transferMessages: sameSession ? prev?.transferMessages : undefined,
        redPacketMessages: sameSession ? prev?.redPacketMessages : undefined,
        callMessages: sameSession ? prev?.callMessages : undefined,
        privateMutualGroups: sameSession ? prev?.privateMutualGroups : undefined,
        groupMemberCount: sameSession ? prev?.groupMemberCount : undefined,
        groupMyMessages: sameSession ? prev?.groupMyMessages : undefined,
        groupActiveSpeakers: sameSession ? prev?.groupActiveSpeakers : undefined,
        groupMutualFriends: sameSession ? prev?.groupMutualFriends : undefined,
        relationStatsLoaded: sameSession ? prev?.relationStatsLoaded : false,
        statsUpdatedAt: sameSession ? prev?.statsUpdatedAt : undefined,
        statsStale: sameSession ? prev?.statsStale : undefined,
        firstMessageTime: sameSession ? prev?.firstMessageTime : undefined,
        latestMessageTime: sameSession ? prev?.latestMessageTime : undefined,
        messageTables: sameSession && Array.isArray(prev?.messageTables) ? prev.messageTables : []
      }
    })
    setIsLoadingDetail(true)
    setIsLoadingDetailExtra(true)

    if (normalizedSessionId.includes('@chatroom')) {
      void (async () => {
        try {
          const hintResult = await window.electronAPI.chat.getGroupMyMessageCountHint(normalizedSessionId)
          if (requestSeq !== detailRequestSeqRef.current) return
          if (!hintResult.success || !Number.isFinite(hintResult.count)) return
          const hintedMyCount = Math.max(0, Math.floor(hintResult.count as number))
          setSessionDetail((prev) => {
            if (!prev || prev.wxid !== normalizedSessionId) return prev
            return {
              ...prev,
              groupMyMessages: hintedMyCount
            }
          })
        } catch {
          // ignore hint errors
        }
      })()
    }

    try {
      updateBackgroundTask(taskId, {
        detail: '正在读取会话基础详情',
        progressText: '基础信息'
      })
      const result = await window.electronAPI.chat.getSessionDetailFast(normalizedSessionId)
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，当前基础查询结束后未继续补充统计'
        })
        return
      }
      if (requestSeq !== detailRequestSeqRef.current) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '会话已切换，旧详情任务已停止'
        })
        return
      }
      if (result.success && result.detail) {
        setSessionDetail((prev) => ({
          wxid: normalizedSessionId,
          displayName: result.detail!.displayName || prev?.displayName || normalizedSessionId,
          remark: result.detail!.remark,
          nickName: result.detail!.nickName,
          alias: result.detail!.alias,
          avatarUrl: result.detail!.avatarUrl || prev?.avatarUrl,
          messageCount: Number.isFinite(result.detail!.messageCount) ? result.detail!.messageCount : prev?.messageCount ?? Number.NaN,
          voiceMessages: prev?.voiceMessages,
          imageMessages: prev?.imageMessages,
          videoMessages: prev?.videoMessages,
          emojiMessages: prev?.emojiMessages,
          transferMessages: prev?.transferMessages,
          redPacketMessages: prev?.redPacketMessages,
          callMessages: prev?.callMessages,
          privateMutualGroups: prev?.privateMutualGroups,
          groupMemberCount: prev?.groupMemberCount,
          groupMyMessages: prev?.groupMyMessages,
          groupActiveSpeakers: prev?.groupActiveSpeakers,
          groupMutualFriends: prev?.groupMutualFriends,
          relationStatsLoaded: prev?.relationStatsLoaded,
          statsUpdatedAt: prev?.statsUpdatedAt,
          statsStale: prev?.statsStale,
          firstMessageTime: prev?.firstMessageTime,
          latestMessageTime: prev?.latestMessageTime,
          messageTables: Array.isArray(prev?.messageTables) ? (prev?.messageTables || []) : []
        }))
      }
    } catch (e) {
      console.error('加载会话详情失败:', e)
    } finally {
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingDetail(false)
      }
    }

    try {
      updateBackgroundTask(taskId, {
        detail: '正在读取补充信息与导出统计',
        progressText: '补充统计'
      })
      const [extraResultSettled, statsResultSettled] = await Promise.allSettled([
        window.electronAPI.chat.getSessionDetailExtra(normalizedSessionId),
        window.electronAPI.chat.getExportSessionStats(
          [normalizedSessionId],
          { includeRelations: false, allowStaleCache: true, cacheOnly: true }
        )
      ])

      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，补充统计结果未继续写入'
        })
        return
      }
      if (requestSeq !== detailRequestSeqRef.current) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '会话已切换，旧补充统计任务已停止'
        })
        return
      }

      if (extraResultSettled.status === 'fulfilled' && extraResultSettled.value.success) {
        const detail = extraResultSettled.value.detail
        if (detail) {
          setSessionDetail((prev) => {
            if (!prev || prev.wxid !== normalizedSessionId) return prev
            return {
              ...prev,
              firstMessageTime: detail.firstMessageTime,
              latestMessageTime: detail.latestMessageTime,
              messageTables: Array.isArray(detail.messageTables) ? detail.messageTables : []
            }
          })
        }
      }

      let refreshIncludeRelations = false
      let shouldRefreshStatsInBackground = false
      if (statsResultSettled.status === 'fulfilled' && statsResultSettled.value.success) {
        const metric = statsResultSettled.value.data?.[normalizedSessionId] as SessionExportMetric | undefined
        const cacheMeta = statsResultSettled.value.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
        refreshIncludeRelations = Boolean(cacheMeta?.includeRelations)
        if (metric) {
          applySessionDetailStats(normalizedSessionId, metric, cacheMeta, refreshIncludeRelations)
        } else if (cacheMeta) {
          setSessionDetail((prev) => {
            if (!prev || prev.wxid !== normalizedSessionId) return prev
            return {
              ...prev,
              relationStatsLoaded: refreshIncludeRelations || prev.relationStatsLoaded,
              statsUpdatedAt: cacheMeta.updatedAt,
              statsStale: cacheMeta.stale
            }
          })
        }
        shouldRefreshStatsInBackground = !metric || Boolean(cacheMeta?.stale)
      } else {
        shouldRefreshStatsInBackground = true
      }
      finishBackgroundTask(taskId, 'completed', {
        detail: '聊天页会话详情统计完成',
        progressText: '已完成'
      })

      if (shouldRefreshStatsInBackground) {
        setIsRefreshingDetailStats(true)
        void (async () => {
          try {
            const freshResult = await window.electronAPI.chat.getExportSessionStats(
              [normalizedSessionId],
              { includeRelations: false, forceRefresh: true }
            )
            if (requestSeq !== detailRequestSeqRef.current) return
            if (freshResult.success && freshResult.data) {
              const freshMetric = freshResult.data[normalizedSessionId] as SessionExportMetric | undefined
              const freshMeta = freshResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
              if (freshMetric) {
                applySessionDetailStats(normalizedSessionId, freshMetric, freshMeta, false)
              } else if (freshMeta) {
                setSessionDetail((prev) => {
                  if (!prev || prev.wxid !== normalizedSessionId) return prev
                  return {
                    ...prev,
                    statsUpdatedAt: freshMeta.updatedAt,
                    statsStale: freshMeta.stale
                  }
                })
              }
            }
          } catch (error) {
            console.error('聊天页后台刷新会话统计失败:', error)
          } finally {
            if (requestSeq === detailRequestSeqRef.current) {
              setIsRefreshingDetailStats(false)
            }
          }
        })()
      }
    } catch (e) {
      console.error('加载会话详情补充统计失败:', e)
      finishBackgroundTask(taskId, 'failed', {
        detail: String(e)
      })
    } finally {
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingDetailExtra(false)
      }
    }
  }, [applySessionDetailStats])

  const loadRelationStats = useCallback(async () => {
    const normalizedSessionId = String(currentSessionId || '').trim()
    if (!normalizedSessionId || isLoadingRelationStats) return

    const requestSeq = detailRequestSeqRef.current
    const taskId = registerBackgroundTask({
      sourcePage: 'chat',
      title: '聊天页关系统计补算',
      detail: `正在补算 ${normalizedSessionId} 的共同好友与关联数据`,
      progressText: '关系统计',
      cancelable: true
    })
    setIsLoadingRelationStats(true)
    try {
      const relationResult = await window.electronAPI.chat.getExportSessionStats(
        [normalizedSessionId],
        { includeRelations: true, forceRefresh: true, preferAccurateSpecialTypes: true }
      )
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，当前关系统计查询结束后未继续刷新'
        })
        return
      }
      if (requestSeq !== detailRequestSeqRef.current) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '会话已切换，旧关系统计任务已停止'
        })
        return
      }

      const metric = relationResult.success && relationResult.data
        ? relationResult.data[normalizedSessionId] as SessionExportMetric | undefined
        : undefined
      const cacheMeta = relationResult.success
        ? relationResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
        : undefined
      if (metric) {
        applySessionDetailStats(normalizedSessionId, metric, cacheMeta, true)
      }

      const needRefresh = relationResult.success &&
        Array.isArray(relationResult.needsRefresh) &&
        relationResult.needsRefresh.includes(normalizedSessionId)

      if (needRefresh) {
        setIsRefreshingDetailStats(true)
        void (async () => {
          try {
            updateBackgroundTask(taskId, {
              detail: '正在刷新关系统计结果',
              progressText: '关系统计刷新'
            })
            const freshResult = await window.electronAPI.chat.getExportSessionStats(
              [normalizedSessionId],
              { includeRelations: true, forceRefresh: true, preferAccurateSpecialTypes: true }
            )
            if (isBackgroundTaskCancelRequested(taskId)) {
              finishBackgroundTask(taskId, 'canceled', {
                detail: '已停止后续加载，刷新结果未继续写入'
              })
              return
            }
            if (requestSeq !== detailRequestSeqRef.current) {
              finishBackgroundTask(taskId, 'canceled', {
                detail: '会话已切换，旧关系统计刷新任务已停止'
              })
              return
            }
            if (freshResult.success && freshResult.data) {
              const freshMetric = freshResult.data[normalizedSessionId] as SessionExportMetric | undefined
              const freshMeta = freshResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
              if (freshMetric) {
                applySessionDetailStats(normalizedSessionId, freshMetric, freshMeta, true)
              }
            }
            finishBackgroundTask(taskId, 'completed', {
              detail: '聊天页关系统计补算完成',
              progressText: '已完成'
            })
          } catch (error) {
            console.error('刷新会话关系统计失败:', error)
            finishBackgroundTask(taskId, 'failed', {
              detail: String(error)
            })
          } finally {
            if (requestSeq === detailRequestSeqRef.current) {
              setIsRefreshingDetailStats(false)
            }
          }
        })()
      } else {
        finishBackgroundTask(taskId, 'completed', {
          detail: '聊天页关系统计补算完成',
          progressText: '已完成'
        })
      }
    } catch (error) {
      console.error('加载会话关系统计失败:', error)
      finishBackgroundTask(taskId, 'failed', {
        detail: String(error)
      })
    } finally {
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingRelationStats(false)
      }
    }
  }, [applySessionDetailStats, currentSessionId, isLoadingRelationStats])

  const normalizeGroupPanelMembers = useCallback((
    payload: GroupPanelMember[],
    options?: { messageCountStatus?: GroupMessageCountStatus }
  ): GroupPanelMember[] => {
    const membersPayload = Array.isArray(payload) ? payload : []
    return membersPayload
      .map((member: GroupPanelMember): GroupPanelMember | null => {
        const username = String(member.username || '').trim()
        if (!username) return null
        const preferredName = String(
          member.groupNickname ||
          member.remark ||
          member.displayName ||
          member.nickname ||
          username
        )
        const rawStatus = member.messageCountStatus
        const normalizedStatus: GroupMessageCountStatus = options?.messageCountStatus
          ?? (rawStatus === 'loading' || rawStatus === 'failed' ? rawStatus : 'ready')

        return {
          username,
          displayName: preferredName,
          avatarUrl: member.avatarUrl,
          nickname: member.nickname,
          alias: member.alias,
          remark: member.remark,
          groupNickname: member.groupNickname,
          isOwner: Boolean(member.isOwner),
          isFriend: Boolean(member.isFriend),
          messageCount: Number.isFinite(member.messageCount) ? Math.max(0, Math.floor(member.messageCount)) : 0,
          messageCountStatus: normalizedStatus
        }
      })
      .filter((member: GroupPanelMember | null): member is GroupPanelMember => Boolean(member))
      .sort((a: GroupPanelMember, b: GroupPanelMember) => {
        const ownerDiff = Number(Boolean(b.isOwner)) - Number(Boolean(a.isOwner))
        if (ownerDiff !== 0) return ownerDiff

        const friendDiff = Number(b.isFriend) - Number(a.isFriend)
        if (friendDiff !== 0) return friendDiff

        const canSortByCount = a.messageCountStatus === 'ready' && b.messageCountStatus === 'ready'
        if (canSortByCount && a.messageCount !== b.messageCount) return b.messageCount - a.messageCount
        return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')
      })
  }, [])

  const normalizeWxidLikeIdentity = useCallback((value?: string): string => {
    const trimmed = String(value || '').trim()
    if (!trimmed) return ''
    const lowered = trimmed.toLowerCase()
    if (lowered.startsWith('wxid_')) {
      const matched = lowered.match(/^(wxid_[^_]+)/i)
      return matched ? matched[1].toLowerCase() : lowered
    }
    const suffixMatch = lowered.match(/^(.+)_([a-z0-9]{4})$/i)
    return suffixMatch ? suffixMatch[1].toLowerCase() : lowered
  }, [])

  const isSelfGroupMember = useCallback((memberUsername?: string): boolean => {
    const selfRaw = String(myWxid || '').trim().toLowerCase()
    const selfNormalized = normalizeWxidLikeIdentity(myWxid)
    if (!selfRaw && !selfNormalized) return false
    const memberRaw = String(memberUsername || '').trim().toLowerCase()
    const memberNormalized = normalizeWxidLikeIdentity(memberUsername)
    return Boolean(
      (selfRaw && memberRaw && selfRaw === memberRaw) ||
      (selfNormalized && memberNormalized && selfNormalized === memberNormalized)
    )
  }, [myWxid, normalizeWxidLikeIdentity])

  const resolveMyGroupMessageCountFromMembers = useCallback((members: GroupPanelMember[]): number | undefined => {
    if (!myWxid) return undefined

    for (const member of members) {
      if (!isSelfGroupMember(member.username)) continue
      if (Number.isFinite(member.messageCount)) {
        return Math.max(0, Math.floor(member.messageCount))
      }
      return 0
    }

    return undefined
  }, [isSelfGroupMember, myWxid])

  const syncGroupMyMessagesFromMembers = useCallback((chatroomId: string, members: GroupPanelMember[]) => {
    const myMessageCount = resolveMyGroupMessageCountFromMembers(members)
    if (!Number.isFinite(myMessageCount)) return

    setSessionDetail((prev) => {
      if (!prev || prev.wxid !== chatroomId || !prev.wxid.includes('@chatroom')) return prev
      return {
        ...prev,
        groupMyMessages: myMessageCount as number
      }
    })
  }, [resolveMyGroupMessageCountFromMembers])

  const updateGroupMembersPanelCache = useCallback((
    chatroomId: string,
    members: GroupPanelMember[],
    includeMessageCounts: boolean
  ) => {
    groupMembersPanelCacheRef.current.set(chatroomId, {
      updatedAt: Date.now(),
      members,
      includeMessageCounts
    })
    if (groupMembersPanelCacheRef.current.size > 80) {
      const oldestEntry = Array.from(groupMembersPanelCacheRef.current.entries())
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
      if (oldestEntry) {
        groupMembersPanelCacheRef.current.delete(oldestEntry[0])
      }
    }
  }, [])

  const setGroupMembersCountStatus = useCallback((
    status: GroupMessageCountStatus,
    options?: { onlyWhenNotReady?: boolean }
  ) => {
    setGroupPanelMembers((prev) => {
      if (!Array.isArray(prev) || prev.length === 0) return prev
      if (options?.onlyWhenNotReady && prev.some((member) => member.messageCountStatus === 'ready')) {
        return prev
      }
      const next = normalizeGroupPanelMembers(prev, { messageCountStatus: status })
      const changed = next.some((member, index) => member.messageCountStatus !== prev[index]?.messageCountStatus)
      return changed ? next : prev
    })
  }, [normalizeGroupPanelMembers])

  const syncGroupMembersMyCountFromDetail = useCallback((chatroomId: string, myMessageCount: number) => {
    if (!chatroomId || !chatroomId.includes('@chatroom')) return
    const normalizedCount = Number.isFinite(myMessageCount) ? Math.max(0, Math.floor(myMessageCount)) : 0

    const patchMembers = (members: GroupPanelMember[]): { changed: boolean; members: GroupPanelMember[] } => {
      if (!Array.isArray(members) || members.length === 0) {
        return { changed: false, members }
      }
      let changed = false
      const patched = members.map((member) => {
        if (!isSelfGroupMember(member.username)) return member
        if (member.messageCount === normalizedCount) return member
        changed = true
        return {
          ...member,
          messageCount: normalizedCount
        }
      })
      if (!changed) return { changed: false, members }
      return { changed: true, members: normalizeGroupPanelMembers(patched) }
    }

    const cached = groupMembersPanelCacheRef.current.get(chatroomId)
    if (cached && cached.members.length > 0) {
      const patchedCache = patchMembers(cached.members)
      if (patchedCache.changed) {
        updateGroupMembersPanelCache(chatroomId, patchedCache.members, true)
      }
    }

    setGroupPanelMembers((prev) => {
      const patched = patchMembers(prev)
      if (!patched.changed) return prev
      return patched.members
    })
  }, [
    isSelfGroupMember,
    normalizeGroupPanelMembers,
    updateGroupMembersPanelCache
  ])

  const getGroupMembersPanelDataWithTimeout = useCallback(async (
    chatroomId: string,
    options: { forceRefresh?: boolean; includeMessageCounts?: boolean },
    timeoutMs: number
  ) => {
    let timeoutTimer: number | null = null
    try {
      const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) => {
        timeoutTimer = window.setTimeout(() => {
          resolve({ success: false, error: '加载群成员超时，请稍后重试' })
        }, timeoutMs)
      })
      return await Promise.race([
        window.electronAPI.groupAnalytics.getGroupMembersPanelData(chatroomId, options),
        timeoutPromise
      ])
    } finally {
      if (timeoutTimer) {
        window.clearTimeout(timeoutTimer)
      }
    }
  }, [])

  const loadGroupMembersPanel = useCallback(async (chatroomId: string) => {
    if (!chatroomId || !isGroupChatSession(chatroomId)) return

    const requestSeq = ++groupMembersRequestSeqRef.current
    const now = Date.now()
    const cached = groupMembersPanelCacheRef.current.get(chatroomId)
    const cacheFresh = Boolean(cached && now - cached.updatedAt < GROUP_MEMBERS_PANEL_CACHE_TTL_MS)
    const hasCachedMembers = Boolean(cached && cached.members.length > 0)
    const hasFreshMessageCounts = Boolean(cacheFresh && cached?.includeMessageCounts)
    let startedBackgroundRefresh = false

    const refreshMessageCountsInBackground = (forceRefresh: boolean) => {
      startedBackgroundRefresh = true
      setIsRefreshingGroupMembers(true)
      setGroupMembersCountStatus('loading', { onlyWhenNotReady: true })
      void (async () => {
        try {
          const countsResult = await getGroupMembersPanelDataWithTimeout(
            chatroomId,
            { forceRefresh, includeMessageCounts: true },
            25000
          )
          if (requestSeq !== groupMembersRequestSeqRef.current) return
          if (!countsResult.success || !Array.isArray(countsResult.data)) {
            setGroupMembersError('成员列表已加载，发言统计稍后再试')
            setGroupMembersCountStatus('failed', { onlyWhenNotReady: true })
            return
          }

          const membersWithCounts = normalizeGroupPanelMembers(
            countsResult.data as GroupPanelMember[],
            { messageCountStatus: 'ready' }
          )
          setGroupPanelMembers(membersWithCounts)
          syncGroupMyMessagesFromMembers(chatroomId, membersWithCounts)
          setGroupMembersError(null)
          updateGroupMembersPanelCache(chatroomId, membersWithCounts, true)
          hasInitializedGroupMembersRef.current = true
        } catch {
          if (requestSeq !== groupMembersRequestSeqRef.current) return
          setGroupMembersError('成员列表已加载，发言统计稍后再试')
          setGroupMembersCountStatus('failed', { onlyWhenNotReady: true })
        } finally {
          if (requestSeq === groupMembersRequestSeqRef.current) {
            setIsRefreshingGroupMembers(false)
          }
        }
      })()
    }

    if (cacheFresh && cached) {
      const cachedMembers = normalizeGroupPanelMembers(
        cached.members,
        { messageCountStatus: cached.includeMessageCounts ? 'ready' : 'loading' }
      )
      setGroupPanelMembers(cachedMembers)
      if (cached.includeMessageCounts) {
        syncGroupMyMessagesFromMembers(chatroomId, cachedMembers)
      }
      setGroupMembersError(null)
      setGroupMembersLoadingHint('')
      setIsLoadingGroupMembers(false)
      hasInitializedGroupMembersRef.current = true
      if (!hasFreshMessageCounts) {
        refreshMessageCountsInBackground(false)
      } else {
        setIsRefreshingGroupMembers(false)
      }
      return
    }

    setGroupMembersError(null)
    if (hasCachedMembers && cached) {
      const cachedMembers = normalizeGroupPanelMembers(
        cached.members,
        { messageCountStatus: cached.includeMessageCounts ? 'ready' : 'loading' }
      )
      setGroupPanelMembers(cachedMembers)
      if (cached.includeMessageCounts) {
        syncGroupMyMessagesFromMembers(chatroomId, cachedMembers)
      }
      setIsRefreshingGroupMembers(true)
      setGroupMembersLoadingHint('')
      setIsLoadingGroupMembers(false)
    } else {
      setGroupPanelMembers([])
      setIsRefreshingGroupMembers(false)
      setIsLoadingGroupMembers(true)
      setGroupMembersLoadingHint(
        hasInitializedGroupMembersRef.current
          ? '加载群成员中...'
          : '首次加载群成员，正在初始化索引（可能需要几秒）'
      )
    }

    try {
      const membersResult = await getGroupMembersPanelDataWithTimeout(
        chatroomId,
        { includeMessageCounts: false, forceRefresh: false },
        12000
      )
      if (requestSeq !== groupMembersRequestSeqRef.current) return

      if (!membersResult.success || !Array.isArray(membersResult.data)) {
        if (!hasCachedMembers) {
          setGroupPanelMembers([])
        }
        setGroupMembersError(membersResult.error || (hasCachedMembers ? '刷新群成员失败，已显示缓存数据' : '加载群成员失败'))
        return
      }

      const members = normalizeGroupPanelMembers(
        membersResult.data as GroupPanelMember[],
        { messageCountStatus: 'loading' }
      )
      setGroupPanelMembers(members)
      setGroupMembersError(null)
      updateGroupMembersPanelCache(chatroomId, members, false)
      hasInitializedGroupMembersRef.current = true
      refreshMessageCountsInBackground(false)
    } catch (e) {
      if (requestSeq !== groupMembersRequestSeqRef.current) return
      if (!hasCachedMembers) {
        setGroupPanelMembers([])
      }
      setGroupMembersError(hasCachedMembers ? '刷新群成员失败，已显示缓存数据' : String(e))
    } finally {
      if (requestSeq === groupMembersRequestSeqRef.current) {
        setIsLoadingGroupMembers(false)
        setGroupMembersLoadingHint('')
        if (!startedBackgroundRefresh) {
          setIsRefreshingGroupMembers(false)
        }
      }
    }
  }, [
    getGroupMembersPanelDataWithTimeout,
    isGroupChatSession,
    syncGroupMyMessagesFromMembers,
    normalizeGroupPanelMembers,
    updateGroupMembersPanelCache
  ])

  const toggleGroupMembersPanel = useCallback(() => {
    if (!currentSessionId || !isGroupChatSession(currentSessionId)) return
    if (showGroupMembersPanel) {
      setShowGroupMembersPanel(false)
      return
    }
    setShowDetailPanel(false)
    setShowGroupMembersPanel(true)
  }, [currentSessionId, showGroupMembersPanel, isGroupChatSession])

  // 切换详情面板
  const toggleDetailPanel = useCallback(() => {
    if (showDetailPanel) {
      setShowDetailPanel(false)
      return
    }
    setShowGroupMembersPanel(false)
    setShowDetailPanel(true)
    if (currentSessionId) {
      void loadSessionDetail(currentSessionId)
    }
  }, [showDetailPanel, currentSessionId, loadSessionDetail])

  useEffect(() => {
    if (!showGroupMembersPanel) return
    if (!currentSessionId || !isGroupChatSession(currentSessionId)) {
      setShowGroupMembersPanel(false)
      return
    }
    setGroupMemberSearchKeyword('')
    void loadGroupMembersPanel(currentSessionId)
  }, [showGroupMembersPanel, currentSessionId, loadGroupMembersPanel, isGroupChatSession])

  useEffect(() => {
    const chatroomId = String(sessionDetail?.wxid || '').trim()
    if (!chatroomId || !chatroomId.includes('@chatroom')) return
    if (!Number.isFinite(sessionDetail?.groupMyMessages)) return
    syncGroupMembersMyCountFromDetail(chatroomId, sessionDetail!.groupMyMessages as number)
  }, [sessionDetail?.groupMyMessages, sessionDetail?.wxid, syncGroupMembersMyCountFromDetail])

  // 复制字段值到剪贴板
  const handleCopyField = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 1500)
    } catch {
      // fallback
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 1500)
    }
  }, [])

  // 连接数据库
  const connect = useCallback(async () => {
    setConnecting(true)
    setConnectionError(null)
    try {
      const scopePromise = resolveChatCacheScope()
      const result = await window.electronAPI.chat.connect()
      if (result.success) {
        setConnected(true)
        const wxidPromise = window.electronAPI.config.get('myWxid')
        await Promise.all([scopePromise, loadSessions(), loadMyAvatar()])
        // 获取 myWxid 用于匹配个人头像
        const wxid = await wxidPromise
        if (wxid) setMyWxid(wxid as string)
      } else {
        setConnectionError(result.error || '连接失败')
      }
    } catch (e) {
      setConnectionError(String(e))
    } finally {
      setConnecting(false)
    }
  }, [loadMyAvatar, resolveChatCacheScope])

  const handleAccountChanged = useCallback(async () => {
    senderAvatarCache.clear()
    senderAvatarLoading.clear()
    quotedSenderDisplayCache.clear()
    quotedSenderDisplayLoading.clear()
    quotedGroupMembersCache.clear()
    quotedGroupMembersLoading.clear()
    sessionContactProfileCacheRef.current.clear()
    pendingSessionContactEnrichRef.current.clear()
    sessionContactEnrichAttemptAtRef.current.clear()
    preloadImageKeysRef.current.clear()
    lastPreloadSessionRef.current = null
    pendingSessionLoadRef.current = null
    initialLoadRequestedSessionRef.current = null
    sessionSwitchRequestSeqRef.current += 1
    sessionWindowCacheRef.current.clear()
    setIsSessionSwitching(false)
    setSessionDetail(null)
    setIsRefreshingDetailStats(false)
    setIsLoadingRelationStats(false)
    setShowDetailPanel(false)
    setShowGroupMembersPanel(false)
    setGroupPanelMembers([])
    setGroupMembersError(null)
    setGroupMembersLoadingHint('')
    setIsRefreshingGroupMembers(false)
    setGroupMemberSearchKeyword('')
    groupMembersRequestSeqRef.current += 1
    groupMembersPanelCacheRef.current.clear()
    hasInitializedGroupMembersRef.current = false
    setIsLoadingGroupMembers(false)
    setCurrentSession(null)
    setSessions([])
    setMessages([])
    setShowScrollToBottom(false)
    suppressScrollToBottomButton(260)
    setSearchKeyword('')
    setConnectionError(null)
    setConnected(false)
    setConnecting(false)
    setHasMoreMessages(true)
    setFoldedView(false)
    setBizView(false)
    setSelectedBizAccount(null)
    setHasMoreLater(false)
    const scope = await resolveChatCacheScope()
    hydrateSessionListCache(scope)
    await connect()
  }, [
    connect,
    resolveChatCacheScope,
    hydrateSessionListCache,
    setConnected,
    setConnecting,
    setConnectionError,
    setCurrentSession,
    setHasMoreLater,
    setHasMoreMessages,
    setMessages,
    setSearchKeyword,
    setSessionDetail,
    setShowDetailPanel,
    setShowGroupMembersPanel,
    suppressScrollToBottomButton,
    setSessions
  ])

  useEffect(() => {
    let canceled = false
    void configService.getAutoTranscribeVoice()
      .then((enabled) => {
        if (!canceled) {
          setAutoTranscribeVoiceEnabled(Boolean(enabled))
        }
      })
      .catch(() => {
        if (!canceled) {
          setAutoTranscribeVoiceEnabled(false)
        }
      })
    return () => {
      canceled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const scope = await resolveChatCacheScope()
      if (cancelled) return
      hydrateSessionListCache(scope)
    })()

    return () => {
      cancelled = true
    }
  }, [resolveChatCacheScope, hydrateSessionListCache])

  // 同步 currentSessionId 到 ref
  useEffect(() => {
    currentSessionRef.current = currentSessionId
    isMessageListAtBottomRef.current = true
    topRangeLoadLockRef.current = false
    bottomRangeLoadLockRef.current = false
    setShowScrollToBottom(false)
    suppressScrollToBottomButton(260)
  }, [currentSessionId, suppressScrollToBottomButton])

  const hydrateSessionStatuses = useCallback(async (sessionList: ChatSession[]) => {
    const usernames = sessionList.map((s) => s.username).filter(Boolean)
    if (usernames.length === 0) return

    try {
      const result = await window.electronAPI.chat.getSessionStatuses(usernames)
      if (!result.success || !result.map) return

      const statusMap = result.map
      const { sessions: latestSessions } = useChatStore.getState()
      if (!Array.isArray(latestSessions) || latestSessions.length === 0) return

      let hasChanges = false
      const updatedSessions = latestSessions.map((session) => {
        const status = statusMap[session.username]
        if (!status) return session

        const nextIsFolded = status.isFolded ?? session.isFolded
        const nextIsMuted = status.isMuted ?? session.isMuted
        if (nextIsFolded === session.isFolded && nextIsMuted === session.isMuted) {
          return session
        }

        hasChanges = true
        return {
          ...session,
          isFolded: nextIsFolded,
          isMuted: nextIsMuted
        }
      })

      if (hasChanges) {
        setSessions(updatedSessions)
      }
    } catch (e) {
      console.warn('会话状态补齐失败:', e)
    }
  }, [setSessions])

  // 加载会话列表（优化：先返回基础数据，异步加载联系人信息）
  const loadSessions = async (options?: { silent?: boolean }) => {
    if (options?.silent) {
      setIsRefreshingSessions(true)
    } else {
      setLoadingSessions(true)
    }
    try {
      const scope = await resolveChatCacheScope()
      const result = await window.electronAPI.chat.getSessions()
      if (result.success && result.sessions) {
        // 确保 sessions 是数组
        const sessionsArray = Array.isArray(result.sessions) ? result.sessions : []
        const nextSessions = mergeSessions(sessionsArray)
        // 确保 nextSessions 也是数组
        if (Array.isArray(nextSessions)) {
          setSessions(nextSessions)
          sessionsRef.current = nextSessions
          persistSessionListCache(scope, nextSessions)
          void hydrateSessionStatuses(nextSessions)
          // 立即启动联系人信息加载，不再延迟 500ms
          void enrichSessionsContactInfo(nextSessions)
        } else {
          console.error('mergeSessions returned non-array:', nextSessions)
          const fallbackSessions = sessionsArray.map((session) => mergeSessionContactPresentation(session))
          setSessions(fallbackSessions)
          sessionsRef.current = fallbackSessions
          persistSessionListCache(scope, fallbackSessions)
          void hydrateSessionStatuses(fallbackSessions)
          void enrichSessionsContactInfo(fallbackSessions)
        }
      } else if (!result.success) {
        setConnectionError(result.error || '获取会话失败')
      }
    } catch (e) {
      console.error('加载会话失败:', e)
      setConnectionError('加载会话失败')
    } finally {
      if (options?.silent) {
        setIsRefreshingSessions(false)
      } else {
        setLoadingSessions(false)
      }
    }
  }

  // 分批异步加载联系人信息（优化：缓存优先 + 可持续队列 + 首屏优先批次）
  const enrichSessionsContactInfo = async (sessions: ChatSession[]) => {
    if (Array.isArray(sessions) && sessions.length > 0) {
      const now = Date.now()
      for (const session of sessions) {
        const username = String(session.username || '').trim()
        if (!username || isFoldPlaceholderSession(username)) continue

        const profileCache = sessionContactProfileCacheRef.current
        const cachedProfile = profileCache.get(username)
        if (cachedProfile && now - cachedProfile.updatedAt > SESSION_CONTACT_PROFILE_CACHE_TTL_MS) {
          profileCache.delete(username)
        }

        const hasAvatar = Boolean(normalizeSearchAvatarUrl(session.avatarUrl))
        const hasDisplayName = Boolean(resolveSessionDisplayName(session.displayName, username))
        if (hasAvatar && hasDisplayName) continue

        const profile = profileCache.get(username)
        const profileHasAvatar = Boolean(normalizeSearchAvatarUrl(profile?.avatarUrl))
        const profileHasDisplayName = Boolean(resolveSessionDisplayName(profile?.displayName, username))
        if (profileHasAvatar && profileHasDisplayName) continue

        const lastAttemptAt = sessionContactEnrichAttemptAtRef.current.get(username) || 0
        if (now - lastAttemptAt < SESSION_CONTACT_PROFILE_RETRY_INTERVAL_MS) continue

        pendingSessionContactEnrichRef.current.add(username)
      }
    }

    if (pendingSessionContactEnrichRef.current.size === 0) return
    if (isEnrichingRef.current) return

    isEnrichingRef.current = true
    enrichCancelledRef.current = false
    const totalStart = performance.now()
    const batchSize = 8
    let processedBatchCount = 0

    try {
      while (!enrichCancelledRef.current && pendingSessionContactEnrichRef.current.size > 0) {
        if (isScrollingRef.current) {
          while (isScrollingRef.current && !enrichCancelledRef.current) {
            await new Promise(resolve => setTimeout(resolve, 120))
          }
        }
        if (enrichCancelledRef.current) break

        const usernames = Array.from(pendingSessionContactEnrichRef.current).slice(0, batchSize)
        if (usernames.length === 0) break
        usernames.forEach((username) => pendingSessionContactEnrichRef.current.delete(username))

        const attemptAt = Date.now()
        usernames.forEach((username) => sessionContactEnrichAttemptAtRef.current.set(username, attemptAt))

        const batchStart = performance.now()
        const shouldRunImmediately = processedBatchCount < 2
        if (shouldRunImmediately) {
          await loadContactInfoBatch(usernames)
        } else {
          await new Promise<void>((resolve) => {
            scheduleWhenIdle(() => {
              void loadContactInfoBatch(usernames).finally(resolve)
            }, { timeout: 700, fallbackDelay: 80 })
          })
        }
        processedBatchCount += 1

        const batchTime = performance.now() - batchStart
        if (batchTime > 200) {
          console.warn(`[性能监控] 联系人批次 ${processedBatchCount} 耗时: ${batchTime.toFixed(2)}ms, batch=${usernames.length}`)
        }

        if (!enrichCancelledRef.current && pendingSessionContactEnrichRef.current.size > 0) {
          const delay = isScrollingRef.current ? 220 : 90
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }

      const totalTime = performance.now() - totalStart
      if (totalTime > 500) {
        console.info(`[性能监控] 联系人补齐总耗时: ${totalTime.toFixed(2)}ms`)
      }
    } catch (e) {
      console.error('加载联系人信息失败:', e)
    } finally {
      isEnrichingRef.current = false
      if (!enrichCancelledRef.current && pendingSessionContactEnrichRef.current.size > 0) {
        void enrichSessionsContactInfo([])
      }
    }
  }

  // 联系人信息更新队列（防抖批量更新，避免频繁重渲染）
  const contactUpdateQueueRef = useRef<Map<string, { displayName?: string; avatarUrl?: string; alias?: string }>>(new Map())
  const contactUpdateTimerRef = useRef<number | null>(null)
  const lastUpdateTimeRef = useRef(0)

  // 批量更新联系人信息（防抖，减少重渲染次数，增加延迟避免阻塞滚动）
  const flushContactUpdates = useCallback(() => {
    if (contactUpdateTimerRef.current) {
      clearTimeout(contactUpdateTimerRef.current)
      contactUpdateTimerRef.current = null
    }

    // 使用短防抖，让头像和昵称更快补齐但依然避免频繁重渲染
    contactUpdateTimerRef.current = window.setTimeout(() => {
      const updates = contactUpdateQueueRef.current
      if (updates.size === 0) return

      const now = Date.now()
      // 如果距离上次更新太近（小于250ms），继续延迟
      if (now - lastUpdateTimeRef.current < 250) {
        contactUpdateTimerRef.current = window.setTimeout(() => {
          flushContactUpdates()
        }, 250 - (now - lastUpdateTimeRef.current))
        return
      }

      const { sessions: currentSessions } = useChatStore.getState()
      if (!Array.isArray(currentSessions)) return

      let hasChanges = false
      const updatedSessions = currentSessions.map(session => {
        const update = updates.get(session.username)
        if (update) {
          const newDisplayName = update.displayName || session.displayName || session.username
          const newAvatarUrl = update.avatarUrl || session.avatarUrl
          const newAlias = update.alias || session.alias
          if (newDisplayName !== session.displayName || newAvatarUrl !== session.avatarUrl || newAlias !== session.alias) {
            hasChanges = true
            return {
              ...session,
              displayName: newDisplayName,
              avatarUrl: newAvatarUrl,
              alias: newAlias
            }
          }
        }
        return session
      })

      if (hasChanges) {
        const updateStart = performance.now()
        setSessions(updatedSessions)
        sessionsRef.current = updatedSessions
        lastUpdateTimeRef.current = Date.now()
        const updateTime = performance.now() - updateStart
        if (updateTime > 50) {
          console.warn(`[性能监控] setSessions更新耗时: ${updateTime.toFixed(2)}ms, 更新了 ${updates.size} 个联系人`)
        }
      }

      updates.clear()
      contactUpdateTimerRef.current = null
    }, 120)
  }, [setSessions])

  // 加载一批联系人信息并更新会话列表（优化：使用队列批量更新）
  const loadContactInfoBatch = async (usernames: string[]) => {
    const startTime = performance.now()
    try {
      // 在数据服务调用前让出控制权（使用 setTimeout 0 代替 setImmediate）
      await new Promise(resolve => setTimeout(resolve, 0))

      const dllStart = performance.now()
      const result = await window.electronAPI.chat.enrichSessionsContactInfo(usernames) as {
        success: boolean
        contacts?: Record<string, { displayName?: string; avatarUrl?: string; alias?: string }>
        error?: string
      }
      const dllTime = performance.now() - dllStart

      //数据服务调用后再次让出控制权
      await new Promise(resolve => setTimeout(resolve, 0))

      const totalTime = performance.now() - startTime
      if (dllTime > 50 || totalTime > 100) {
        console.warn(`[性能监控] DLL调用耗时: ${dllTime.toFixed(2)}ms, 总耗时: ${totalTime.toFixed(2)}ms, usernames: ${usernames.length}`)
      }

      if (result.success && result.contacts) {
        // 将更新加入队列，用于侧边栏更新
        const contacts = result.contacts || {}
        for (const [username, contact] of Object.entries(contacts)) {
          const normalizedDisplayName = resolveSessionDisplayName(contact.displayName, username) || contact.displayName
          const normalizedAvatarUrl = normalizeSearchAvatarUrl(contact.avatarUrl)
          const normalizedAlias = normalizeSearchIdentityText(contact.alias)
          contactUpdateQueueRef.current.set(username, {
            displayName: normalizedDisplayName,
            avatarUrl: normalizedAvatarUrl,
            alias: normalizedAlias
          })

          if (normalizedDisplayName || normalizedAvatarUrl || normalizedAlias) {
            sessionContactProfileCacheRef.current.set(username, {
              displayName: normalizedDisplayName,
              avatarUrl: normalizedAvatarUrl,
              alias: normalizedAlias,
              updatedAt: Date.now()
            })
          }

          // 如果是自己的信息且当前个人头像为空，同步更新
          if (myWxid && username === myWxid && normalizedAvatarUrl && !myAvatarUrl) {

            setMyAvatarUrl(normalizedAvatarUrl)
          }

          // 【核心优化】同步更新全局发送者头像缓存，供 MessageBubble 使用
          senderAvatarCache.set(username, {
            avatarUrl: normalizedAvatarUrl,
            displayName: normalizedDisplayName
          })
        }
        // 触发批量更新
        flushContactUpdates()
      }
    } catch (e) {
      console.error('加载联系人信息批次失败:', e)
    }
  }

  // 刷新会话列表
  const handleRefresh = async () => {
    setJumpStartTime(0)
    setJumpEndTime(0)
    setHasMoreLater(false)
    await loadSessions({ silent: true })
  }

  // 刷新当前会话消息（增量更新新消息）
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false)

  /**
   * 极速增量刷新：基于最后一条消息时间戳，获取后续新消息
   * (由用户建议：记住上一条消息时间，自动取之后的并渲染，然后后台兜底全量同步)
   */
  const handleIncrementalRefresh = async () => {
    if (!currentSessionId || isRefreshingRef.current) return
    isRefreshingRef.current = true
    setIsRefreshingMessages(true)

    // 找出当前已渲染消息中的最大时间戳（使用 getState 获取最新状态，避免闭包过时导致重复）
    const currentMessages = useChatStore.getState().messages || []
    const lastMsg = currentMessages[currentMessages.length - 1]
    const minTime = lastMsg?.createTime || 0

    // 1. 优先执行增量查询并渲染（第一步）
    try {
      const result = await (window.electronAPI.chat as any).getNewMessages(currentSessionId, minTime) as {
        success: boolean;
        messages?: Message[];
        error?: string
      }

      if (result.success && result.messages && result.messages.length > 0) {
        // 过滤去重：必须对比实时的状态，防止在 handleRefreshMessages 运行期间导致的冲突
        const latestMessages = useChatStore.getState().messages || []
        const existingKeys = new Set(latestMessages.map(getMessageKey))
        const newOnes = result.messages.filter(m => !existingKeys.has(getMessageKey(m)))

        if (newOnes.length > 0) {
          appendMessages(newOnes, false)
          flashNewMessages(newOnes.map(getMessageKey))
          // 滚动到底部
          requestAnimationFrame(() => {
            const latestMessages = useChatStore.getState().messages || []
            const lastIndex = latestMessages.length - 1
            if (lastIndex >= 0 && messageVirtuosoRef.current) {
              messageVirtuosoRef.current.scrollToIndex({ index: lastIndex, align: 'end', behavior: 'auto' })
            } else if (messageListRef.current) {
              messageListRef.current.scrollTop = messageListRef.current.scrollHeight
            }
          })
        }
      }
    } catch (e) {
      console.warn('[IncrementalRefresh] 失败，将依赖全量同步兜底:', e)
    } finally {
      isRefreshingRef.current = false
      setIsRefreshingMessages(false)
    }
  }

  const handleRefreshMessages = async () => {
    if (!currentSessionId || isRefreshingRef.current) return
    setJumpStartTime(0)
    setJumpEndTime(0)
    setHasMoreLater(false)
    setIsRefreshingMessages(true)
    isRefreshingRef.current = true
    try {
      // 获取最新消息并增量添加
      const result = await window.electronAPI.chat.getLatestMessages(currentSessionId, 50) as {
        success: boolean;
        messages?: Message[];
        error?: string
      }
      if (!result.success || !result.messages) {
        return
      }
      // 使用实时状态进行去重对比
      const latestMessages = useChatStore.getState().messages || []
      const existing = new Set(latestMessages.map(getMessageKey))
      const lastMsg = latestMessages[latestMessages.length - 1]
      const lastTime = lastMsg?.createTime ?? 0

      const newMessages = result.messages.filter((msg) => {
        const key = getMessageKey(msg)
        if (existing.has(key)) return false
        // 这里的 lastTime 仅作参考过滤，主要的去重靠 key
        if (lastTime > 0 && msg.createTime < lastTime - 3600) return false // 仅过滤 1 小时之前的冗余请求
        return true
      })
      if (newMessages.length > 0) {
        appendMessages(newMessages, false)
        flashNewMessages(newMessages.map(getMessageKey))
        // 滚动到底部
        requestAnimationFrame(() => {
          const currentMessages = useChatStore.getState().messages || []
          const lastIndex = currentMessages.length - 1
          if (lastIndex >= 0 && messageVirtuosoRef.current) {
            messageVirtuosoRef.current.scrollToIndex({ index: lastIndex, align: 'end', behavior: 'auto' })
          } else if (messageListRef.current) {
            messageListRef.current.scrollTop = messageListRef.current.scrollHeight
          }
        })
      }
    } catch (e) {
      console.error('刷新消息失败:', e)
    } finally {
      isRefreshingRef.current = false
      setIsRefreshingMessages(false)
    }
  }
  // 消息批量大小控制（保持稳定，避免游标反复重建）
  const currentBatchSizeRef = useRef(50)

  const warmupGroupSenderProfiles = useCallback((usernames: string[], defer = false) => {
    if (!Array.isArray(usernames) || usernames.length === 0) return

    const runWarmup = () => {
      const batchPromise = loadContactInfoBatch(usernames)
      usernames.forEach(username => {
        if (!senderAvatarLoading.has(username)) {
          senderAvatarLoading.set(username, batchPromise.then(() => senderAvatarCache.get(username) || null))
        }
      })
      batchPromise.finally(() => {
        usernames.forEach(username => senderAvatarLoading.delete(username))
      })
    }

    if (defer) {
      scheduleWhenIdle(runWarmup, { timeout: 1200, fallbackDelay: 120 })
      return
    }

    runWarmup()
  }, [loadContactInfoBatch])

  const scheduleGroupSenderWarmup = useCallback((usernames: string[], defer = false) => {
    if (!Array.isArray(usernames) || usernames.length === 0) return
    const run = () => warmupGroupSenderProfiles(usernames, false)
    if (!defer && !isMessageListScrollingRef.current) {
      run()
      return
    }

    const runWhenIdle = () => {
      if (isMessageListScrollingRef.current) {
        window.setTimeout(runWhenIdle, MESSAGE_LIST_SCROLL_IDLE_MS)
        return
      }
      run()
    }

    scheduleWhenIdle(runWhenIdle, { timeout: 1200, fallbackDelay: MESSAGE_LIST_SCROLL_IDLE_MS })
  }, [warmupGroupSenderProfiles])

  // 加载消息
  const loadMessages = async (
    sessionId: string,
    offset = 0,
    startTime = 0,
    endTime = 0,
    ascending = false,
    options: LoadMessagesOptions = {}
  ) => {
    const isPrependHistoryLoad = offset > 0 && !ascending
    if (isPrependHistoryLoad) {
      prependingHistoryRef.current = true
    }
    const listEl = messageListRef.current
    const session = sessionMapRef.current.get(sessionId)
    const unreadCount = session?.unreadCount ?? 0

    let messageLimit: number

    if (offset === 0) {
      const preferredLimit = Number.isFinite(options.forceInitialLimit)
        ? Math.max(10, Math.floor(options.forceInitialLimit as number))
        : (unreadCount > 99 ? 30 : 40)
      currentBatchSizeRef.current = preferredLimit
      messageLimit = preferredLimit
    } else {
      // 同一会话内保持固定批量，避免后端游标因 batch 改变而重建
      messageLimit = currentBatchSizeRef.current
    }


    if (offset === 0) {
      suppressScrollToBottomButton(260)
      setShowScrollToBottom(false)
      setLoadingMessages(true)
      // 切会话时保留旧内容作为过渡，避免大面积闪烁
      setHasInitialMessages(true)
    } else {
      setLoadingMore(true)
    }

    const visibleRange = visibleMessageRangeRef.current
    const visibleStartIndex = Math.min(
      Math.max(visibleRange.startIndex, 0),
      Math.max(messages.length - 1, 0)
    )
    // 记录加载前的第一条消息元素（非虚拟列表回退路径）
    const firstMsgEl = listEl?.querySelector('.message-wrapper') as HTMLElement | null

    try {
      const useLatestPath = offset === 0 && startTime === 0 && endTime === 0 && !ascending && options.preferLatestPath
      const result = (useLatestPath
        ? await window.electronAPI.chat.getLatestMessages(sessionId, messageLimit)
        : await window.electronAPI.chat.getMessages(sessionId, offset, messageLimit, startTime, endTime, ascending)
      ) as {
        success: boolean;
        messages?: Message[];
        hasMore?: boolean;
        nextOffset?: number;
        error?: string
      }
      const isStaleSwitchRequest = Boolean(
        options.switchRequestSeq && options.switchRequestSeq !== sessionSwitchRequestSeqRef.current
      )
      const isStaleInSessionJumpRequest = Boolean(
        options.inSessionJumpRequestSeq && options.inSessionJumpRequestSeq !== inSessionResultJumpRequestSeqRef.current
      )
      if (isStaleSwitchRequest || isStaleInSessionJumpRequest) {
        return
      }
      if (options.switchRequestSeq && options.switchRequestSeq !== sessionSwitchRequestSeqRef.current) {
        return
      }
      if (currentSessionRef.current !== sessionId) {
        return
      }
      if (result.success && result.messages) {
        const resultMessages = result.messages
        if (offset === 0) {
          setMessages(resultMessages)
          persistSessionPreviewCache(sessionId, resultMessages)
          if (resultMessages.length === 0) {
            setNoMessageTable(true)
            setHasMoreMessages(false)
          }

          // 群聊发送者信息补齐改为非阻塞执行，避免影响首屏切换
          const isGroup = sessionId.includes('@chatroom')
          if (isGroup && resultMessages.length > 0) {
            const unknownSenders = [...new Set(resultMessages
              .filter(m => m.isSend !== 1 && m.senderUsername && !senderAvatarCache.has(m.senderUsername))
              .map(m => m.senderUsername as string)
            )]
            if (unknownSenders.length > 0) {
              scheduleGroupSenderWarmup(unknownSenders, options.deferGroupSenderWarmup === true)
            }
          }

          // 日期跳转时滚动到顶部，否则滚动到底部
          requestAnimationFrame(() => {
            if (isDateJumpRef.current) {
              if (messageVirtuosoRef.current && resultMessages.length > 0) {
                messageVirtuosoRef.current.scrollToIndex({ index: 0, align: 'start', behavior: 'auto' })
              } else if (messageListRef.current) {
                messageListRef.current.scrollTop = 0
              }
              isDateJumpRef.current = false
              return
            }

            const lastIndex = resultMessages.length - 1
            if (lastIndex >= 0 && messageVirtuosoRef.current) {
              messageVirtuosoRef.current.scrollToIndex({ index: lastIndex, align: 'end', behavior: 'auto' })
            } else if (messageListRef.current) {
              messageListRef.current.scrollTop = messageListRef.current.scrollHeight
            }
          })
        } else {
          const existingMessageKeys = messageKeySetRef.current
          const incomingSeen = new Set<string>()
          let prependedInsertedCount = 0
          for (const row of resultMessages) {
            const key = getMessageKey(row)
            if (incomingSeen.has(key)) continue
            incomingSeen.add(key)
            if (!existingMessageKeys.has(key)) {
              prependedInsertedCount += 1
            }
          }

          suppressAutoScrollOnNextMessageGrowthRef.current = true
          appendMessages(resultMessages, true)

          // 加载更多也同样处理发送者信息预取
          const isGroup = sessionId.includes('@chatroom')
          if (isGroup) {
            const unknownSenders = [...new Set(resultMessages
              .filter(m => m.isSend !== 1 && m.senderUsername && !senderAvatarCache.has(m.senderUsername))
              .map(m => m.senderUsername as string)
            )]
            if (unknownSenders.length > 0) {
              scheduleGroupSenderWarmup(unknownSenders, false)
            }
          }

          // 加载更早消息后保持视口锚点，避免跳屏
          requestAnimationFrame(() => {
            if (messageVirtuosoRef.current) {
              const latestMessages = useChatStore.getState().messages || []
              const anchorIndex = Math.min(
                Math.max(visibleStartIndex + prependedInsertedCount, 0),
                Math.max(latestMessages.length - 1, 0)
              )
              if (latestMessages.length > 0) {
                messageVirtuosoRef.current.scrollToIndex({ index: anchorIndex, align: 'start', behavior: 'auto' })
              }
              return
            }

            if (firstMsgEl && listEl) {
              listEl.scrollTop = firstMsgEl.offsetTop - 80
            }
          })
        }
        // 日期跳转(ascending=true)：不往上加载更早的，往下加载更晚的
        if (ascending) {
          setHasMoreMessages(false)
          setHasMoreLater(result.hasMore ?? false)
        } else {
          setHasMoreMessages(result.hasMore ?? false)
          if (offset === 0) {
            if (endTime > 0) {
              setHasMoreLater(true)
            } else {
              setHasMoreLater(false)
            }
          }
        }
        const nextOffset = typeof result.nextOffset === 'number'
          ? result.nextOffset
          : offset + resultMessages.length
        setCurrentOffset(nextOffset)
      } else if (!result.success) {
        setNoMessageTable(true)
        setHasMoreMessages(false)
      }
    } catch (e) {
      console.error('加载消息失败:', e)
      setConnectionError('加载消息失败')
      setHasMoreMessages(false)
      if (offset === 0 && currentSessionRef.current === sessionId) {
        setMessages([])
      }
    } finally {
      if (isPrependHistoryLoad) {
        requestAnimationFrame(() => {
          prependingHistoryRef.current = false
        })
      }
      setLoadingMessages(false)
      setLoadingMore(false)
      if (offset === 0 && pendingSessionLoadRef.current === sessionId) {
        if (!options.switchRequestSeq || options.switchRequestSeq === sessionSwitchRequestSeqRef.current) {
          pendingSessionLoadRef.current = null
          initialLoadRequestedSessionRef.current = null
          setIsSessionSwitching(false)

          // 处理从全局搜索跳转过来的情况
          const pendingSearch = pendingInSessionSearchRef.current
          if (pendingSearch?.sessionId === sessionId) {
            pendingInSessionSearchRef.current = null
            void applyPendingInSessionSearch(sessionId, pendingSearch, options.switchRequestSeq)
          }
        }
      }
    }
  }

  const handleJumpDateSelect = useCallback((date: Date, options: { sessionId?: string; switchRequestSeq?: number } = {}) => {
    const targetSessionId = String(options.sessionId || currentSessionRef.current || currentSessionId || '').trim()
    if (!targetSessionId) return
    const targetDate = new Date(date)
    const end = Math.floor(targetDate.setHours(23, 59, 59, 999) / 1000)
    // 日期跳转采用“锚点定位”而非“当天过滤”：
    // 先定位到当日附近，再允许上下滚动跨天浏览。
    isDateJumpRef.current = false
    setCurrentOffset(0)
    setJumpStartTime(0)
    setJumpEndTime(end)
    suppressAutoLoadLaterRef.current = true
    setShowJumpPopover(false)
    void loadMessages(targetSessionId, 0, 0, end, false, {
      switchRequestSeq: options.switchRequestSeq,
      forceInitialLimit: 120
    })
  }, [currentSessionId, loadMessages])

  const cancelInSessionSearchTasks = useCallback(() => {
    inSessionSearchGenRef.current += 1
    if (inSessionSearchTimerRef.current) {
      clearTimeout(inSessionSearchTimerRef.current)
      inSessionSearchTimerRef.current = null
    }
    setInSessionSearching(false)
    setInSessionEnriching(false)
  }, [])

  const cancelInSessionSearchJump = useCallback(() => {
    inSessionResultJumpRequestSeqRef.current += 1
    if (inSessionResultJumpTimerRef.current) {
      window.clearTimeout(inSessionResultJumpTimerRef.current)
      inSessionResultJumpTimerRef.current = null
    }
  }, [])

  const resolveSearchSessionContext = useCallback((sessionId?: string) => {
    const normalizedSessionId = String(sessionId || currentSessionRef.current || currentSessionId || '').trim()
    const currentSearchSession = normalizedSessionId && Array.isArray(sessions)
      ? sessions.find(session => session.username === normalizedSessionId)
      : undefined
    const resolvedSession = currentSearchSession
      ? (
          standaloneSessionWindow &&
          normalizedInitialSessionId &&
          currentSearchSession.username === normalizedInitialSessionId
            ? {
                ...currentSearchSession,
                displayName: currentSearchSession.displayName || fallbackDisplayName || currentSearchSession.username,
                avatarUrl: currentSearchSession.avatarUrl || fallbackAvatarUrl || undefined
              }
            : currentSearchSession
        )
      : (
          normalizedSessionId
            ? {
                username: normalizedSessionId,
                displayName: fallbackDisplayName || normalizedSessionId,
                avatarUrl: fallbackAvatarUrl || undefined
              } as ChatSession
            : undefined
        )
    const isGroupSearchSession = Boolean(
      resolvedSession && (
        isGroupChatSession(resolvedSession.username) ||
        (
          standaloneSessionWindow &&
          resolvedSession.username === normalizedInitialSessionId &&
          normalizedStandaloneInitialContactType === 'group'
        )
      )
    )
    const isDirectSearchSession = Boolean(
      resolvedSession &&
      isSingleContactSession(resolvedSession.username) &&
      !isGroupSearchSession
    )
    return {
      normalizedSessionId,
      resolvedSession,
      isDirectSearchSession,
      isGroupSearchSession,
      resolvedSessionDisplayName: normalizeSearchIdentityText(resolvedSession?.displayName) || normalizedSessionId || undefined,
      resolvedSessionAvatarUrl: normalizeSearchAvatarUrl(resolvedSession?.avatarUrl)
    }
  }, [
    currentSessionId,
    fallbackAvatarUrl,
    fallbackDisplayName,
    normalizedInitialSessionId,
    normalizedStandaloneInitialContactType,
    sessions,
    standaloneSessionWindow,
    isGroupChatSession
  ])

  const hydrateInSessionSearchResults = useCallback((rawMessages: Message[], sessionId?: string) => {
    const sortedMessages = sortMessagesByCreateTimeDesc(rawMessages || [])
    if (sortedMessages.length === 0) return []

    const {
      normalizedSessionId,
      isDirectSearchSession,
      isGroupSearchSession,
      resolvedSessionDisplayName,
      resolvedSessionAvatarUrl
    } = resolveSearchSessionContext(sessionId)
    const resolvedSessionUsernameFallback = resolveSearchSenderUsernameFallback(normalizedSessionId)

    return sortedMessages.map((message) => {
      const senderUsername = normalizeSearchIdentityText(message.senderUsername) || message.senderUsername
      const inferredSelfFromSender = isGroupSearchSession && isCurrentUserSearchIdentity(senderUsername, myWxid)
      const senderDisplayName = resolveSearchSenderDisplayName(
        message.senderDisplayName,
        senderUsername,
        normalizedSessionId
      )
      const senderUsernameFallback = resolveSearchSenderUsernameFallback(senderUsername)
      const senderAvatarUrl = normalizeSearchAvatarUrl(message.senderAvatarUrl)
      const nextIsSend = inferredSelfFromSender ? 1 : message.isSend
      const nextSenderDisplayName = nextIsSend === 1
        ? (senderDisplayName || '我')
        : (
            senderDisplayName ||
            (isDirectSearchSession ? resolvedSessionDisplayName : undefined) ||
            senderUsernameFallback ||
            (isDirectSearchSession ? resolvedSessionUsernameFallback : undefined) ||
            '未知'
          )
      const nextSenderAvatarUrl = nextIsSend === 1
        ? (senderAvatarUrl || myAvatarUrl)
        : (senderAvatarUrl || (isDirectSearchSession ? resolvedSessionAvatarUrl : undefined))

      if (
        senderUsername === message.senderUsername &&
        nextIsSend === message.isSend &&
        nextSenderDisplayName === message.senderDisplayName &&
        nextSenderAvatarUrl === message.senderAvatarUrl
      ) {
        return message
      }

      return {
        ...message,
        isSend: nextIsSend,
        senderUsername,
        senderDisplayName: nextSenderDisplayName,
        senderAvatarUrl: nextSenderAvatarUrl
      }
    })
  }, [currentSessionId, myAvatarUrl, myWxid, resolveSearchSessionContext])

  const enrichMessagesWithSenderProfiles = useCallback(async (rawMessages: Message[], sessionId?: string) => {
    let messages = hydrateInSessionSearchResults(rawMessages, sessionId)
    if (messages.length === 0) return []

    const sessionContext = resolveSearchSessionContext(sessionId)
    const { normalizedSessionId, isDirectSearchSession, isGroupSearchSession } = sessionContext
    let resolvedSessionDisplayName = sessionContext.resolvedSessionDisplayName
    let resolvedSessionAvatarUrl = sessionContext.resolvedSessionAvatarUrl

    if (
      normalizedSessionId &&
      isDirectSearchSession &&
      (
        !resolvedSessionAvatarUrl ||
        !resolvedSessionDisplayName ||
        resolvedSessionDisplayName === normalizedSessionId
      )
    ) {
      try {
        const result = await window.electronAPI.chat.enrichSessionsContactInfo([normalizedSessionId])
        const profile = result.success && result.contacts ? result.contacts[normalizedSessionId] : undefined
        const profileDisplayName = resolveSearchSenderDisplayName(
          profile?.displayName,
          normalizedSessionId,
          normalizedSessionId
        )
        const profileAvatarUrl = normalizeSearchAvatarUrl(profile?.avatarUrl)
        if (profileDisplayName) {
          resolvedSessionDisplayName = profileDisplayName
        }
        if (profileAvatarUrl) {
          resolvedSessionAvatarUrl = profileAvatarUrl
        }
        if (profileDisplayName || profileAvatarUrl) {
          messages = messages.map((message) => {
            if (message.isSend === 1) return message
            const preservedDisplayName = resolveSearchSenderDisplayName(
              message.senderDisplayName,
              message.senderUsername,
              normalizedSessionId
            )
            return {
              ...message,
              senderDisplayName: preservedDisplayName ||
                profileDisplayName ||
                resolvedSessionDisplayName ||
                resolveSearchSenderUsernameFallback(message.senderUsername) ||
                message.senderDisplayName,
              senderAvatarUrl: normalizeSearchAvatarUrl(message.senderAvatarUrl) || profileAvatarUrl || resolvedSessionAvatarUrl || message.senderAvatarUrl
            }
          })
        }
      } catch {
        // ignore session profile enrichment errors and keep raw search results usable
      }
    }

    if (normalizedSessionId && isGroupSearchSession) {
      const missingSenderMessages = messages.filter((message) => {
        if (message.localId <= 0) return false
        if (message.isSend === 1) return false
        return !normalizeSearchIdentityText(message.senderUsername)
      })

      if (missingSenderMessages.length > 0) {
        const messageByLocalId = new Map<number, Message>()
        for (let index = 0; index < missingSenderMessages.length; index += 8) {
          const batch = missingSenderMessages.slice(index, index + 8)
          const detailResults = await Promise.allSettled(
            batch.map(async (message) => {
              const result = await window.electronAPI.chat.getMessage(normalizedSessionId, message.localId)
              if (!result.success || !result.message) return null
              return {
                localId: message.localId,
                message: hydrateInSessionSearchResults([{
                  ...message,
                  ...result.message,
                  parsedContent: message.parsedContent || result.message.parsedContent,
                  rawContent: message.rawContent || result.message.rawContent,
                  content: message.content || result.message.content
                } as Message], normalizedSessionId)[0]
              }
            })
          )

          for (const detail of detailResults) {
            if (detail.status !== 'fulfilled' || !detail.value?.message) continue
            messageByLocalId.set(detail.value.localId, detail.value.message)
          }
        }

        if (messageByLocalId.size > 0) {
          messages = messages.map(message => messageByLocalId.get(message.localId) || message)
        }
      }
    }

    const profileMap = new Map<string, { avatarUrl?: string; displayName?: string }>()
    const pendingLoads: Array<Promise<void>> = []
    const missingUsernames: string[] = []

    const usernames = [...new Set(
      messages
        .map((message) => normalizeSearchIdentityText(message.senderUsername))
        .filter((username): username is string => Boolean(username))
    )]

    for (const username of usernames) {
      const cached = senderAvatarCache.get(username)
      if (cached) {
        profileMap.set(username, cached)
        continue
      }

      const pending = senderAvatarLoading.get(username)
      if (pending) {
        pendingLoads.push(
          pending.then((profile) => {
            if (profile) {
              profileMap.set(username, profile)
            }
          }).catch(() => {})
        )
        continue
      }

      missingUsernames.push(username)
    }

    if (pendingLoads.length > 0) {
      await Promise.allSettled(pendingLoads)
    }

    if (missingUsernames.length > 0) {
      try {
        const result = await window.electronAPI.chat.enrichSessionsContactInfo(missingUsernames)
        if (result.success && result.contacts) {
          for (const [username, profile] of Object.entries(result.contacts)) {
            const normalizedProfile = {
              avatarUrl: profile.avatarUrl,
              displayName: profile.displayName
            }
            profileMap.set(username, normalizedProfile)
            senderAvatarCache.set(username, normalizedProfile)
          }
        }
      } catch {
        // ignore sender enrichment errors and keep raw search results usable
      }
    }

    return messages.map((message) => {
      const sender = normalizeSearchIdentityText(message.senderUsername)
      const profile = sender ? profileMap.get(sender) : undefined
      const inferredSelfFromSender = isGroupSearchSession && isCurrentUserSearchIdentity(sender, myWxid)
      const profileDisplayName = resolveSearchSenderDisplayName(
        profile?.displayName,
        sender,
        normalizedSessionId
      )
      const currentSenderDisplayName = resolveSearchSenderDisplayName(
        message.senderDisplayName,
        sender,
        normalizedSessionId
      )
      const senderUsernameFallback = resolveSearchSenderUsernameFallback(sender)
      const sessionUsernameFallback = resolveSearchSenderUsernameFallback(normalizedSessionId)
      const currentSenderAvatarUrl = normalizeSearchAvatarUrl(message.senderAvatarUrl)
      const nextIsSend = inferredSelfFromSender ? 1 : message.isSend
      const nextSenderDisplayName = nextIsSend === 1
        ? (currentSenderDisplayName || profileDisplayName || '我')
        : (
            profileDisplayName ||
            currentSenderDisplayName ||
            (isDirectSearchSession ? resolvedSessionDisplayName : undefined) ||
            senderUsernameFallback ||
            (isDirectSearchSession ? sessionUsernameFallback : undefined) ||
            '未知'
          )
      const nextSenderAvatarUrl = nextIsSend === 1
        ? (currentSenderAvatarUrl || myAvatarUrl || normalizeSearchAvatarUrl(profile?.avatarUrl))
        : (
            currentSenderAvatarUrl ||
            normalizeSearchAvatarUrl(profile?.avatarUrl) ||
            (isDirectSearchSession ? resolvedSessionAvatarUrl : undefined)
          )

      if (
        sender === message.senderUsername &&
        nextIsSend === message.isSend &&
        nextSenderDisplayName === message.senderDisplayName &&
        nextSenderAvatarUrl === message.senderAvatarUrl
      ) {
        return message
      }

      return {
        ...message,
        isSend: nextIsSend,
        senderUsername: sender || message.senderUsername,
        senderDisplayName: nextSenderDisplayName,
        senderAvatarUrl: nextSenderAvatarUrl
      }
    })
  }, [
    currentSessionId,
    hydrateInSessionSearchResults,
    myAvatarUrl,
    myWxid,
    resolveSearchSessionContext
  ])

  const applyPendingInSessionSearch = useCallback(async (
    sessionId: string,
    payload: PendingInSessionSearchPayload,
    switchRequestSeq?: number
  ) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return
    if (payload.sessionId !== normalizedSessionId) return
    if (switchRequestSeq && switchRequestSeq !== sessionSwitchRequestSeqRef.current) return
    if (currentSessionRef.current !== normalizedSessionId) return

    const immediateResults = hydrateInSessionSearchResults(payload.results || [], normalizedSessionId)
    setShowInSessionSearch(true)
    setInSessionQuery(payload.keyword)
    setInSessionSearchError(null)
    setInSessionResults(immediateResults)

    if (payload.firstMsgTime > 0) {
      handleJumpDateSelect(new Date(payload.firstMsgTime * 1000), {
        sessionId: normalizedSessionId,
        switchRequestSeq
      })
    }

    setInSessionEnriching(true)
    void enrichMessagesWithSenderProfiles(immediateResults, normalizedSessionId).then((enrichedResults) => {
      if (switchRequestSeq && switchRequestSeq !== sessionSwitchRequestSeqRef.current) return
      if (currentSessionRef.current !== normalizedSessionId) return
      setInSessionResults(enrichedResults)
    }).catch(() => {
      // ignore sender enrichment errors and keep current search results usable
    }).finally(() => {
      if (switchRequestSeq && switchRequestSeq !== sessionSwitchRequestSeqRef.current) return
      if (currentSessionRef.current !== normalizedSessionId) return
      setInSessionEnriching(false)
    })
  }, [enrichMessagesWithSenderProfiles, handleJumpDateSelect, hydrateInSessionSearchResults])

  // 加载更晚的消息
  const loadLaterMessages = useCallback(async () => {
    if (!currentSessionId || isLoadingMore || isLoadingMessages || messages.length === 0) return

    setLoadingMore(true)
    try {
      const lastMsg = messages[messages.length - 1]
      // 从最后一条消息的时间开始往后找
      const result = await window.electronAPI.chat.getMessages(currentSessionId, 0, 50, lastMsg.createTime, 0, true) as {
        success: boolean;
        messages?: Message[];
        hasMore?: boolean;
        error?: string
      }

      if (result.success && result.messages) {
        // 过滤掉已经在列表中的重复消息
        const existingKeys = messageKeySetRef.current
        const newMsgs = result.messages.filter(m => !existingKeys.has(getMessageKey(m)))

        if (newMsgs.length > 0) {
          appendMessages(newMsgs, false)
        }
        setHasMoreLater(result.hasMore ?? false)
      }
    } catch (e) {
      console.error('加载后续消息失败:', e)
    } finally {
      setLoadingMore(false)
    }
  }, [currentSessionId, isLoadingMore, isLoadingMessages, messages, getMessageKey, appendMessages, setHasMoreLater, setLoadingMore])

  const refreshSessionIncrementally = useCallback(async (sessionId: string, switchRequestSeq?: number) => {
    const currentMessages = useChatStore.getState().messages || []
    const lastMsg = currentMessages[currentMessages.length - 1]
    const minTime = lastMsg?.createTime || 0
    if (!sessionId || minTime <= 0) return

    try {
      const result = await window.electronAPI.chat.getNewMessages(sessionId, minTime, 120) as {
        success: boolean
        messages?: Message[]
        error?: string
      }
      if (switchRequestSeq && switchRequestSeq !== sessionSwitchRequestSeqRef.current) return
      if (currentSessionRef.current !== sessionId) return
      if (!result.success || !Array.isArray(result.messages) || result.messages.length === 0) return

      const latestMessages = useChatStore.getState().messages || []
      const existing = new Set(latestMessages.map(getMessageKey))
      const newMessages = result.messages.filter((msg) => !existing.has(getMessageKey(msg)))
      if (newMessages.length > 0) {
        appendMessages(newMessages, false)
      }
    } catch (error) {
      console.warn('[SessionCache] 增量刷新失败:', error)
    }
  }, [appendMessages, getMessageKey])

  // 选择会话
  const selectSessionById = useCallback((sessionId: string, options: { force?: boolean } = {}) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId || (!options.force && normalizedSessionId === currentSessionId)) return
    const switchRequestSeq = sessionSwitchRequestSeqRef.current + 1
    sessionSwitchRequestSeqRef.current = switchRequestSeq
    currentSessionRef.current = normalizedSessionId

    const pendingSearch = pendingInSessionSearchRef.current
    const shouldPreservePendingSearch = pendingSearch?.sessionId === normalizedSessionId
    cancelInSessionSearchTasks()
    cancelInSessionSearchJump()

    // 清空会话内搜索状态（除非是从全局搜索跳转过来）
    if (!shouldPreservePendingSearch) {
      pendingInSessionSearchRef.current = null
      setShowInSessionSearch(false)
      setInSessionQuery('')
      setInSessionResults([])
      setInSessionSearchError(null)
    }

    setCurrentSession(normalizedSessionId, { preserveMessages: false })
    setNoMessageTable(false)

    const restoredFromWindowCache = restoreSessionWindowCache(normalizedSessionId)
    if (restoredFromWindowCache) {
      pendingSessionLoadRef.current = null
      initialLoadRequestedSessionRef.current = null
      setIsSessionSwitching(false)

      // 处理从全局搜索跳转过来的情况
      if (pendingSearch?.sessionId === normalizedSessionId) {
        pendingInSessionSearchRef.current = null
        void applyPendingInSessionSearch(normalizedSessionId, pendingSearch, switchRequestSeq)
      }

      void refreshSessionIncrementally(normalizedSessionId, switchRequestSeq)
    } else {
      pendingSessionLoadRef.current = normalizedSessionId
      initialLoadRequestedSessionRef.current = normalizedSessionId
      setIsSessionSwitching(true)
      void hydrateSessionPreview(normalizedSessionId)
      setCurrentOffset(0)
      setJumpStartTime(0)
      setJumpEndTime(0)
      void loadMessages(normalizedSessionId, 0, 0, 0, false, {
        preferLatestPath: true,
        deferGroupSenderWarmup: true,
        forceInitialLimit: 30,
        switchRequestSeq
      })
    }
    // 切换会话后回到正常聊天窗口：收起详情侧栏，详情需手动再次展开
    setShowJumpPopover(false)
    setShowDetailPanel(false)
    setShowGroupMembersPanel(false)
    setGroupMemberSearchKeyword('')
    setGroupMembersError(null)
    setGroupMembersLoadingHint('')
    setIsRefreshingGroupMembers(false)
    groupMembersRequestSeqRef.current += 1
    setIsLoadingGroupMembers(false)
    setSessionDetail(null)
    setIsRefreshingDetailStats(false)
    setIsLoadingRelationStats(false)
  }, [
    currentSessionId,
    setCurrentSession,
    restoreSessionWindowCache,
    refreshSessionIncrementally,
    hydrateSessionPreview,
    loadMessages,
    cancelInSessionSearchJump,
    cancelInSessionSearchTasks,
    applyPendingInSessionSearch
  ])

  // 选择会话
  const handleSelectSession = (session: ChatSession) => {
    // 点击折叠群入口，切换到折叠群视图
    if (session.username.toLowerCase().includes('placeholder_foldgroup')) {
      setFoldedView(true)
      return
    }
    // 点击公众号入口，切换到公众号视图
    if (session.username === OFFICIAL_ACCOUNTS_VIRTUAL_ID) {
      setBizView(true)
      setSelectedBizAccount(null) // 切入时默认不选中任何公众号
      return
    }
    selectSessionById(session.username)
  }

  // 搜索过滤
  const handleSearch = (keyword: string) => {
    setSearchKeyword(keyword)
  }

  // 关闭搜索框
  const handleCloseSearch = () => {
    setSearchKeyword('')
  }

  // 会话内搜索
  const inSessionSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inSessionSearchGenRef = useRef(0)
  const handleInSessionSearch = useCallback(async (keyword: string) => {
    setInSessionQuery(keyword)
    if (inSessionSearchTimerRef.current) clearTimeout(inSessionSearchTimerRef.current)
    inSessionSearchTimerRef.current = null
    inSessionSearchGenRef.current += 1
    if (!keyword.trim() || !currentSessionId) {
      setInSessionResults([])
      setInSessionSearchError(null)
      setInSessionSearching(false)
      setInSessionEnriching(false)
      return
    }
    setInSessionSearchError(null)
    const gen = inSessionSearchGenRef.current
    const sid = currentSessionId
    inSessionSearchTimerRef.current = setTimeout(async () => {
      if (gen !== inSessionSearchGenRef.current) return
      setInSessionSearching(true)
      try {
        const res = await window.electronAPI.chat.searchMessages(keyword.trim(), sid, 50, 0)
        if (!res?.success) {
          throw new Error(res?.error || '搜索失败')
        }
        if (gen !== inSessionSearchGenRef.current || currentSessionRef.current !== sid) return
        const messages = hydrateInSessionSearchResults(res?.messages || [], sid)
        setInSessionResults(messages)
        setInSessionSearchError(null)

        setInSessionEnriching(true)
        void enrichMessagesWithSenderProfiles(messages, sid).then((enriched) => {
          if (gen !== inSessionSearchGenRef.current || currentSessionRef.current !== sid) return
          setInSessionResults(enriched)
        }).catch(() => {
          // ignore sender enrichment errors and keep current search results usable
        }).finally(() => {
          if (gen !== inSessionSearchGenRef.current || currentSessionRef.current !== sid) return
          setInSessionEnriching(false)
        })
      } catch (error) {
        if (gen !== inSessionSearchGenRef.current || currentSessionRef.current !== sid) return
        setInSessionResults([])
        setInSessionSearchError(error instanceof Error ? error.message : String(error))
        setInSessionEnriching(false)
      } finally {
        if (gen === inSessionSearchGenRef.current) setInSessionSearching(false)
      }
    }, 500)
  }, [currentSessionId, enrichMessagesWithSenderProfiles, hydrateInSessionSearchResults])

  const handleToggleInSessionSearch = useCallback(() => {
    setShowInSessionSearch(v => {
      if (v) {
        cancelInSessionSearchTasks()
        cancelInSessionSearchJump()
        setInSessionQuery('')
        setInSessionResults([])
        setInSessionSearchError(null)
      } else {
        setTimeout(() => inSessionSearchRef.current?.focus(), 50)
      }
      return !v
    })
  }, [cancelInSessionSearchJump, cancelInSessionSearchTasks])

  // 全局消息搜索
  const globalMsgSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalMsgSearchGenRef = useRef(0)
  const ensureGlobalMsgSearchNotStale = useCallback((gen: number) => {
    if (gen !== globalMsgSearchGenRef.current) {
      throw new Error(GLOBAL_MSG_SEARCH_CANCELED_ERROR)
    }
  }, [])

  const runLegacyGlobalMsgSearch = useCallback(async (
    keyword: string,
    sessionList: ChatSession[],
    gen: number
  ): Promise<GlobalMsgSearchResult[]> => {
    const results: GlobalMsgSearchResult[] = []
    for (let index = 0; index < sessionList.length; index += GLOBAL_MSG_LEGACY_CONCURRENCY) {
      ensureGlobalMsgSearchNotStale(gen)
      const chunk = sessionList.slice(index, index + GLOBAL_MSG_LEGACY_CONCURRENCY)
      const chunkResults = await Promise.allSettled(
        chunk.map(async (session) => {
          const res = await window.electronAPI.chat.searchMessages(keyword, session.username, GLOBAL_MSG_PER_SESSION_LIMIT, 0)
          if (!res?.success) {
            throw new Error(res?.error || `搜索失败: ${session.username}`)
          }
          return normalizeGlobalMsgSearchMessages(res?.messages || [], session.username)
        })
      )
      ensureGlobalMsgSearchNotStale(gen)

      for (const item of chunkResults) {
        if (item.status === 'rejected') {
          throw item.reason instanceof Error ? item.reason : new Error(String(item.reason))
        }
        if (item.value.length > 0) {
          results.push(...item.value)
        }
      }
    }
    return sortMessagesByCreateTimeDesc(results)
  }, [ensureGlobalMsgSearchNotStale])

  const compareGlobalMsgSearchShadow = useCallback((
    keyword: string,
    stagedResults: GlobalMsgSearchResult[],
    legacyResults: GlobalMsgSearchResult[]
  ) => {
    const stagedMap = buildGlobalMsgSearchSessionLocalIds(stagedResults)
    const legacyMap = buildGlobalMsgSearchSessionLocalIds(legacyResults)
    const stagedSessions = Object.keys(stagedMap).sort()
    const legacySessions = Object.keys(legacyMap).sort()

    let mismatch = stagedSessions.length !== legacySessions.length
    if (!mismatch) {
      for (let i = 0; i < stagedSessions.length; i += 1) {
        if (stagedSessions[i] !== legacySessions[i]) {
          mismatch = true
          break
        }
      }
    }

    if (!mismatch) {
      for (const sessionId of stagedSessions) {
        const stagedIds = stagedMap[sessionId] || []
        const legacyIds = legacyMap[sessionId] || []
        if (stagedIds.length !== legacyIds.length) {
          mismatch = true
          break
        }
        for (let i = 0; i < stagedIds.length; i += 1) {
          if (stagedIds[i] !== legacyIds[i]) {
            mismatch = true
            break
          }
        }
        if (mismatch) break
      }
    }

    if (!mismatch) {
      const stagedOrder = stagedResults.map((row) => `${row.sessionId}:${row.localId || 0}:${row.messageKey || ''}`)
      const legacyOrder = legacyResults.map((row) => `${row.sessionId}:${row.localId || 0}:${row.messageKey || ''}`)
      if (stagedOrder.length !== legacyOrder.length) {
        mismatch = true
      } else {
        for (let i = 0; i < stagedOrder.length; i += 1) {
          if (stagedOrder[i] !== legacyOrder[i]) {
            mismatch = true
            break
          }
        }
      }
    }

    if (!mismatch) return
    console.warn('[GlobalMsgSearch] shadow compare mismatch', {
      keyword,
      stagedSessionCount: stagedSessions.length,
      legacySessionCount: legacySessions.length,
      stagedResultCount: stagedResults.length,
      legacyResultCount: legacyResults.length,
      stagedMap,
      legacyMap
    })
  }, [])

  const handleGlobalMsgSearch = useCallback(async (keyword: string) => {
    const normalizedKeyword = keyword.trim()
    setGlobalMsgQuery(keyword)
    if (globalMsgSearchTimerRef.current) clearTimeout(globalMsgSearchTimerRef.current)
    globalMsgSearchTimerRef.current = null
    globalMsgSearchGenRef.current += 1
    if (!normalizedKeyword) {
      pendingGlobalMsgSearchReplayRef.current = null
      globalMsgPrefixCacheRef.current = null
      setGlobalMsgResults([])
      setGlobalMsgSearchError(null)
      setShowGlobalMsgSearch(false)
      setGlobalMsgSearching(false)
      setGlobalMsgSearchPhase('idle')
      setGlobalMsgIsBackfilling(false)
      setGlobalMsgAuthoritativeSessionCount(0)
      return
    }
    setShowGlobalMsgSearch(true)
    setGlobalMsgSearchError(null)
    setGlobalMsgSearchPhase('seed')
    setGlobalMsgIsBackfilling(false)
    setGlobalMsgAuthoritativeSessionCount(0)

    const sessionList = Array.isArray(sessionsRef.current) ? sessionsRef.current.filter((session) => String(session.username || '').trim()) : []
    if (!isConnectedRef.current || sessionList.length === 0) {
      pendingGlobalMsgSearchReplayRef.current = normalizedKeyword
      setGlobalMsgResults([])
      setGlobalMsgSearchError(null)
      setGlobalMsgSearching(false)
      setGlobalMsgSearchPhase('idle')
      setGlobalMsgIsBackfilling(false)
      setGlobalMsgAuthoritativeSessionCount(0)
      return
    }

    pendingGlobalMsgSearchReplayRef.current = null
    const gen = globalMsgSearchGenRef.current
    globalMsgSearchTimerRef.current = setTimeout(async () => {
      if (gen !== globalMsgSearchGenRef.current) return
      setGlobalMsgSearching(true)
      setGlobalMsgSearchPhase('seed')
      setGlobalMsgIsBackfilling(false)
      setGlobalMsgAuthoritativeSessionCount(0)
      try {
        ensureGlobalMsgSearchNotStale(gen)

        const seedResponse = await window.electronAPI.chat.searchMessages(normalizedKeyword, undefined, GLOBAL_MSG_SEED_LIMIT, 0)
        if (!seedResponse?.success) {
          throw new Error(seedResponse?.error || '搜索失败')
        }
        ensureGlobalMsgSearchNotStale(gen)

        const seedRows = normalizeGlobalMsgSearchMessages(seedResponse?.messages || [])
        const seedMap = buildGlobalMsgSearchSessionMap(seedRows)
        const authoritativeMap = new Map<string, GlobalMsgSearchResult[]>()
        setGlobalMsgResults(composeGlobalMsgSearchResults(seedMap, authoritativeMap))
        setGlobalMsgSearchError(null)
        setGlobalMsgSearchPhase('backfill')
        setGlobalMsgIsBackfilling(true)

        const previousPrefixCache = globalMsgPrefixCacheRef.current
        const previousKeyword = String(previousPrefixCache?.keyword || '').trim()
        const canUsePrefixCache = Boolean(
          previousPrefixCache &&
          previousPrefixCache.completed &&
          previousKeyword &&
          normalizedKeyword.startsWith(previousKeyword)
        )
        let targetSessionList = canUsePrefixCache
          ? sessionList.filter((session) => previousPrefixCache?.matchedSessionIds.has(session.username))
          : sessionList
        if (canUsePrefixCache && previousPrefixCache) {
          let foundOutsidePrefix = false
          for (const sessionId of seedMap.keys()) {
            if (!previousPrefixCache.matchedSessionIds.has(sessionId)) {
              foundOutsidePrefix = true
              break
            }
          }
          if (foundOutsidePrefix) {
            targetSessionList = sessionList
          }
        }

        for (let index = 0; index < targetSessionList.length; index += GLOBAL_MSG_BACKFILL_CONCURRENCY) {
          ensureGlobalMsgSearchNotStale(gen)
          const chunk = targetSessionList.slice(index, index + GLOBAL_MSG_BACKFILL_CONCURRENCY)
          const chunkResults = await Promise.allSettled(
            chunk.map(async (session) => {
              const res = await window.electronAPI.chat.searchMessages(normalizedKeyword, session.username, GLOBAL_MSG_PER_SESSION_LIMIT, 0)
              if (!res?.success) {
                throw new Error(res?.error || `搜索失败: ${session.username}`)
              }
              return {
                sessionId: session.username,
                messages: normalizeGlobalMsgSearchMessages(res?.messages || [], session.username)
              }
            })
          )
          ensureGlobalMsgSearchNotStale(gen)

          for (const item of chunkResults) {
            if (item.status === 'rejected') {
              throw item.reason instanceof Error ? item.reason : new Error(String(item.reason))
            }
            authoritativeMap.set(item.value.sessionId, item.value.messages)
          }
          setGlobalMsgAuthoritativeSessionCount(authoritativeMap.size)
          setGlobalMsgResults(composeGlobalMsgSearchResults(seedMap, authoritativeMap))
        }

        ensureGlobalMsgSearchNotStale(gen)
        const finalResults = composeGlobalMsgSearchResults(seedMap, authoritativeMap)
        setGlobalMsgResults(finalResults)
        setGlobalMsgSearchError(null)
        setGlobalMsgSearchPhase('done')
        setGlobalMsgIsBackfilling(false)

        const matchedSessionIds = new Set<string>()
        for (const row of finalResults) {
          matchedSessionIds.add(row.sessionId)
        }
        globalMsgPrefixCacheRef.current = {
          keyword: normalizedKeyword,
          matchedSessionIds,
          completed: true
        }

        if (shouldRunGlobalMsgShadowCompareSample()) {
          void (async () => {
            try {
              const legacyResults = await runLegacyGlobalMsgSearch(normalizedKeyword, sessionList, gen)
              if (gen !== globalMsgSearchGenRef.current) return
              compareGlobalMsgSearchShadow(normalizedKeyword, finalResults, legacyResults)
            } catch (error) {
              if (isGlobalMsgSearchCanceled(error)) return
              console.warn('[GlobalMsgSearch] shadow compare failed:', error)
            }
          })()
        }
      } catch (error) {
        if (isGlobalMsgSearchCanceled(error)) return
        if (gen !== globalMsgSearchGenRef.current) return
        setGlobalMsgResults([])
        setGlobalMsgSearchError(error instanceof Error ? error.message : String(error))
        setGlobalMsgSearchPhase('done')
        setGlobalMsgIsBackfilling(false)
        setGlobalMsgAuthoritativeSessionCount(0)
        globalMsgPrefixCacheRef.current = null
      } finally {
        if (gen === globalMsgSearchGenRef.current) setGlobalMsgSearching(false)
      }
    }, 500)
  }, [compareGlobalMsgSearchShadow, ensureGlobalMsgSearchNotStale, runLegacyGlobalMsgSearch])

  const handleCloseGlobalMsgSearch = useCallback(() => {
    globalMsgSearchGenRef.current += 1
    if (globalMsgSearchTimerRef.current) clearTimeout(globalMsgSearchTimerRef.current)
    globalMsgSearchTimerRef.current = null
    pendingGlobalMsgSearchReplayRef.current = null
    globalMsgPrefixCacheRef.current = null
    setShowGlobalMsgSearch(false)
    setGlobalMsgQuery('')
    setGlobalMsgResults([])
    setGlobalMsgSearchError(null)
    setGlobalMsgSearching(false)
    setGlobalMsgSearchPhase('idle')
    setGlobalMsgIsBackfilling(false)
    setGlobalMsgAuthoritativeSessionCount(0)
  }, [])

  const handleMessageRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    visibleMessageRangeRef.current = range
    const total = messages.length
    const shouldWarmupVisibleGroupSenders = Boolean(
      currentSessionId && (
        isGroupChatSession(currentSessionId) ||
        (
          standaloneSessionWindow &&
          normalizedInitialSessionId &&
          currentSessionId === normalizedInitialSessionId &&
          normalizedStandaloneInitialContactType === 'group'
        )
      )
    )
    if (total <= 0) {
      isMessageListAtBottomRef.current = true
      setShowScrollToBottom(prev => (prev ? false : prev))
      return
    }

    if (shouldWarmupVisibleGroupSenders) {
      const now = Date.now()
      if (now - lastVisibleSenderWarmupAtRef.current >= 180) {
        lastVisibleSenderWarmupAtRef.current = now
        const latestMessages = useChatStore.getState().messages || []
        const visibleStart = Math.max(range.startIndex - 12, 0)
        const visibleEnd = Math.min(range.endIndex + 20, total - 1)
        const pendingUsernames = new Set<string>()
        for (let index = visibleStart; index <= visibleEnd; index += 1) {
          const msg = latestMessages[index]
          if (!msg || msg.isSend === 1) continue
          const sender = String(msg.senderUsername || '').trim()
          if (!sender) continue
          if (senderAvatarCache.has(sender) || senderAvatarLoading.has(sender)) continue
          pendingUsernames.add(sender)
          if (pendingUsernames.size >= 24) break
        }
        if (pendingUsernames.size > 0) {
          scheduleGroupSenderWarmup([...pendingUsernames], false)
        }
      }
    }
  }, [
    messages.length,
    currentSessionId,
    isGroupChatSession,
    standaloneSessionWindow,
    normalizedInitialSessionId,
    normalizedStandaloneInitialContactType,
    scheduleGroupSenderWarmup
  ])

  const handleMessageAtBottomStateChange = useCallback((atBottom: boolean) => {
    if (messages.length <= 0) {
      isMessageListAtBottomRef.current = true
      setShowScrollToBottom(prev => (prev ? false : prev))
      return
    }

    const listEl = messageListRef.current
    const distanceFromBottom = listEl
      ? (listEl.scrollHeight - (listEl.scrollTop + listEl.clientHeight))
      : Number.POSITIVE_INFINITY
    const nearBottomByDistance = distanceFromBottom <= 140
    const effectiveAtBottom = atBottom || nearBottomByDistance
    isMessageListAtBottomRef.current = effectiveAtBottom

    if (!effectiveAtBottom) {
      bottomRangeLoadLockRef.current = false
      // 用户主动离开底部后，解除“搜索跳转后的自动向后加载抑制”
      suppressAutoLoadLaterRef.current = false
    }

    if (
      isLoadingMessages ||
      isSessionSwitching ||
      isLoadingMore ||
      suppressScrollToBottomButtonRef.current
    ) {
      setShowScrollToBottom(prev => (prev ? false : prev))
      return
    }

    if (effectiveAtBottom) {
      setShowScrollToBottom(prev => (prev ? false : prev))
      return
    }
    const shouldShow = distanceFromBottom > 180
    setShowScrollToBottom(prev => (prev === shouldShow ? prev : shouldShow))
  }, [messages.length, isLoadingMessages, isLoadingMore, isSessionSwitching])

  const handleMessageListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    markMessageListScrolling()
    if (!currentSessionId || isLoadingMore || isLoadingMessages) return
    const listEl = messageListRef.current
    if (!listEl) return
    const distanceFromTop = listEl.scrollTop
    const distanceFromBottom = listEl.scrollHeight - (listEl.scrollTop + listEl.clientHeight)

    if (event.deltaY <= -18) {
      if (!hasMoreMessages) return
      if (distanceFromTop > MESSAGE_EDGE_TRIGGER_DISTANCE_PX) return
      if (topRangeLoadLockRef.current) return
      const now = Date.now()
      if (now - topRangeLoadLastTriggerAtRef.current < MESSAGE_TOP_WHEEL_LOAD_COOLDOWN_MS) return
      topRangeLoadLastTriggerAtRef.current = now
      topRangeLoadLockRef.current = true
      isMessageListAtBottomRef.current = false
      void loadMessages(currentSessionId, currentOffset, jumpStartTime, jumpEndTime)
      return
    }

    if (event.deltaY <= 18) return
    if (!hasMoreLater) return
    if (distanceFromBottom > MESSAGE_EDGE_TRIGGER_DISTANCE_PX) return
    if (bottomRangeLoadLockRef.current) return

    // 用户明确向下滚动时允许加载后续消息
    suppressAutoLoadLaterRef.current = false
    bottomRangeLoadLockRef.current = true
    void loadLaterMessages()
  }, [
    currentSessionId,
    hasMoreLater,
    hasMoreMessages,
    isLoadingMessages,
    isLoadingMore,
    currentOffset,
    jumpStartTime,
    jumpEndTime,
    markMessageListScrolling,
    loadMessages,
    loadLaterMessages
  ])

  const handleMessageAtTopStateChange = useCallback((atTop: boolean) => {
    if (!atTop) {
      topRangeLoadLockRef.current = false
    }
  }, [])


  const isSameSession = useCallback((prev: ChatSession, next: ChatSession): boolean => {
    return (
      prev.username === next.username &&
      prev.type === next.type &&
      prev.unreadCount === next.unreadCount &&
      prev.summary === next.summary &&
      prev.sortTimestamp === next.sortTimestamp &&
      prev.lastTimestamp === next.lastTimestamp &&
      prev.lastMsgType === next.lastMsgType &&
      prev.displayName === next.displayName &&
      prev.avatarUrl === next.avatarUrl &&
      prev.alias === next.alias
    )
  }, [])

  const mergeSessions = useCallback((nextSessions: ChatSession[]) => {
    // 确保输入是数组
    if (!Array.isArray(nextSessions)) {
      console.warn('mergeSessions: nextSessions is not an array:', nextSessions)
      return Array.isArray(sessionsRef.current) ? sessionsRef.current : []
    }
    if (!Array.isArray(sessionsRef.current) || sessionsRef.current.length === 0) {
      return nextSessions.map((next) => mergeSessionContactPresentation(next))
    }
    const prevMap = new Map(sessionsRef.current.map((s) => [s.username, s]))
    return nextSessions.map((next) => {
      const prev = prevMap.get(next.username)
      const merged = mergeSessionContactPresentation(next, prev)
      if (!prev) return merged
      return isSameSession(prev, merged) ? prev : merged
    })
  }, [isSameSession, mergeSessionContactPresentation])

  const flashNewMessages = useCallback((keys: string[]) => {
    if (keys.length === 0) return
    setHighlightedMessageKeys((prev) => [...prev, ...keys])
    window.setTimeout(() => {
      setHighlightedMessageKeys((prev) => prev.filter((k) => !keys.includes(k)))
    }, 2500)
  }, [])

  const handleInSessionResultJump = useCallback((msg: Message) => {
    const targetTime = Number(msg.createTime || 0)
    const targetSessionId = String(currentSessionRef.current || currentSessionId || '').trim()
    if (!targetTime || !targetSessionId) return

    if (inSessionResultJumpTimerRef.current) {
      window.clearTimeout(inSessionResultJumpTimerRef.current)
      inSessionResultJumpTimerRef.current = null
    }

    const requestSeq = inSessionResultJumpRequestSeqRef.current + 1
    inSessionResultJumpRequestSeqRef.current = requestSeq
    const anchorEndTime = targetTime + 1
    const targetMessageKey = getMessageKey(msg)

    inSessionResultJumpTimerRef.current = window.setTimeout(() => {
      inSessionResultJumpTimerRef.current = null
      if (requestSeq !== inSessionResultJumpRequestSeqRef.current) return
      if (currentSessionRef.current !== targetSessionId) return

      setCurrentOffset(0)
      setJumpStartTime(0)
      setJumpEndTime(anchorEndTime)
      // 搜索跳转后默认不自动回流到最新消息，仅在用户主动向下滚动时加载后续
      suppressAutoLoadLaterRef.current = true
      flashNewMessages([targetMessageKey])
      void loadMessages(targetSessionId, 0, 0, anchorEndTime, false, {
        inSessionJumpRequestSeq: requestSeq
      })
    }, 220)
  }, [currentSessionId, flashNewMessages, getMessageKey, loadMessages])

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    suppressScrollToBottomButton(220)
    isMessageListAtBottomRef.current = true
    setShowScrollToBottom(false)
    const lastIndex = messages.length - 1
    if (lastIndex >= 0 && messageVirtuosoRef.current) {
      messageVirtuosoRef.current.scrollToIndex({
        index: lastIndex,
        align: 'end',
        behavior: 'auto'
      })
      return
    }
    if (messageListRef.current) {
      messageListRef.current.scrollTo({
        top: messageListRef.current.scrollHeight,
        behavior: 'auto'
      })
    }
  }, [messages.length, suppressScrollToBottomButton])

  // 拖动调节侧边栏宽度
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)

    const startX = e.clientX
    const startWidth = sidebarWidth

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX
      const newWidth = Math.min(Math.max(startWidth + delta, 200), 400)
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [sidebarWidth])

  // 初始化连接
  useEffect(() => {
    if (!isConnected && !isConnecting) {
      connect()
    }

    // 组件卸载时清理
    return () => {
      avatarLoadQueue.clear()
      if (previewPersistTimerRef.current !== null) {
        window.clearTimeout(previewPersistTimerRef.current)
        previewPersistTimerRef.current = null
      }
      if (sessionListPersistTimerRef.current !== null) {
        window.clearTimeout(sessionListPersistTimerRef.current)
        sessionListPersistTimerRef.current = null
      }
      if (scrollBottomButtonArmTimerRef.current !== null) {
        window.clearTimeout(scrollBottomButtonArmTimerRef.current)
        scrollBottomButtonArmTimerRef.current = null
      }
      if (contactUpdateTimerRef.current) {
        clearTimeout(contactUpdateTimerRef.current)
      }
      if (sessionScrollTimeoutRef.current) {
        clearTimeout(sessionScrollTimeoutRef.current)
      }
      if (messageListScrollTimeoutRef.current !== null) {
        window.clearTimeout(messageListScrollTimeoutRef.current)
        messageListScrollTimeoutRef.current = null
      }
      isMessageListScrollingRef.current = false
      contactUpdateQueueRef.current.clear()
      pendingSessionContactEnrichRef.current.clear()
      sessionContactEnrichAttemptAtRef.current.clear()
      sessionContactProfileCacheRef.current.clear()
      enrichCancelledRef.current = true
      isEnrichingRef.current = false
    }
  }, [])

  useEffect(() => {
    const handleChange = () => {
      void handleAccountChanged()
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [handleAccountChanged])

  useEffect(() => {
    const nextSet = new Set<string>()
    for (const msg of messages) {
      nextSet.add(getMessageKey(msg))
    }
    messageKeySetRef.current = nextSet
    const lastMsg = messages[messages.length - 1]
    lastMessageTimeRef.current = lastMsg?.createTime ?? 0
  }, [messages, getMessageKey])

  useEffect(() => {
    lastObservedMessageCountRef.current = messages.length
    if (messages.length <= 0) {
      isMessageListAtBottomRef.current = true
    }
  }, [currentSessionId])

  useEffect(() => {
    const previousCount = lastObservedMessageCountRef.current
    const currentCount = messages.length
    lastObservedMessageCountRef.current = currentCount
    if (currentCount <= previousCount) return
    if (!currentSessionId || isLoadingMessages || isSessionSwitching) return
    if (suppressAutoScrollOnNextMessageGrowthRef.current || prependingHistoryRef.current) {
      suppressAutoScrollOnNextMessageGrowthRef.current = false
      return
    }
    if (!isMessageListAtBottomRef.current) return
    if (suppressAutoLoadLaterRef.current) return
    suppressScrollToBottomButton(220)
    isMessageListAtBottomRef.current = true
    requestAnimationFrame(() => {
      const latestMessages = useChatStore.getState().messages || []
      const lastIndex = latestMessages.length - 1
      if (lastIndex >= 0 && messageVirtuosoRef.current) {
        messageVirtuosoRef.current.scrollToIndex({ index: lastIndex, align: 'end', behavior: 'auto' })
      }
    })
  }, [messages.length, currentSessionId, isLoadingMessages, isSessionSwitching, suppressScrollToBottomButton])

  useEffect(() => {
    currentSessionRef.current = currentSessionId
  }, [currentSessionId])

  useEffect(() => {
    if (currentSessionId !== lastPreloadSessionRef.current) {
      preloadImageKeysRef.current.clear()
      lastPreloadSessionRef.current = currentSessionId
    }
  }, [currentSessionId])

  useEffect(() => {
    if (!currentSessionId || messages.length === 0) return
    const preloadEdgeCount = 40
    const maxPreload = 30
    const head = messages.slice(0, preloadEdgeCount)
    const tail = messages.slice(-preloadEdgeCount)
    const candidates = [...head, ...tail]
    const queued = preloadImageKeysRef.current
    const seen = new Set<string>()
    const payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }> = []
    for (const msg of candidates) {
      if (payloads.length >= maxPreload) break
      if (msg.localType !== 3) continue
      const cacheKey = msg.imageMd5 || msg.imageDatName || `local:${msg.localId}`
      if (!msg.imageMd5 && !msg.imageDatName) continue
      if (imageDataUrlCache.has(cacheKey)) continue
      const taskKey = `${currentSessionId}|${cacheKey}`
      if (queued.has(taskKey) || seen.has(taskKey)) continue
      queued.add(taskKey)
      seen.add(taskKey)
      payloads.push({
        sessionId: currentSessionId,
        imageMd5: msg.imageMd5 || undefined,
        imageDatName: msg.imageDatName
      })
    }
    if (payloads.length > 0) {
      window.electronAPI.image.preload(payloads).catch(() => { })
    }
  }, [currentSessionId, messages])

  useEffect(() => {
    const nextMap = new Map<string, ChatSession>()
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        nextMap.set(session.username, session)
      }
    }
    sessionMapRef.current = nextMap
  }, [sessions])

  useEffect(() => {
    if (!Array.isArray(sessions) || sessions.length === 0) return
    const now = Date.now()
    const cache = sessionContactProfileCacheRef.current

    for (const session of sessions) {
      const username = String(session.username || '').trim()
      if (!username || isFoldPlaceholderSession(username)) continue

      const displayName = resolveSessionDisplayName(session.displayName, username)
      const avatarUrl = normalizeSearchAvatarUrl(session.avatarUrl)
      const alias = normalizeSearchIdentityText(session.alias)
      if (!displayName && !avatarUrl && !alias) continue

      const prev = cache.get(username)
      cache.set(username, {
        displayName: displayName || prev?.displayName,
        avatarUrl: avatarUrl || prev?.avatarUrl,
        alias: alias || prev?.alias,
        updatedAt: now
      })
    }

    for (const [username, profile] of cache.entries()) {
      if (now - profile.updatedAt > SESSION_CONTACT_PROFILE_CACHE_TTL_MS) {
        cache.delete(username)
      }
    }
  }, [sessions])

  useEffect(() => {
    sessionsRef.current = Array.isArray(sessions) ? sessions : []
  }, [sessions])

  useEffect(() => {
    if (!isLoadingMore) {
      topRangeLoadLockRef.current = false
      bottomRangeLoadLockRef.current = false
    }
  }, [isLoadingMore])

  useEffect(() => {
    if (initialRevealTimerRef.current !== null) {
      window.clearTimeout(initialRevealTimerRef.current)
      initialRevealTimerRef.current = null
    }
    if (!isLoadingMessages) {
      if (messages.length === 0) {
        setHasInitialMessages(true)
      } else {
        initialRevealTimerRef.current = window.setTimeout(() => {
          setHasInitialMessages(true)
          initialRevealTimerRef.current = null
        }, 120)
      }
    }
  }, [isLoadingMessages, messages.length])

  useEffect(() => {
    if (currentSessionId !== prevSessionRef.current) {
      prevSessionRef.current = currentSessionId
      setNoMessageTable(false)
      if (initialRevealTimerRef.current !== null) {
        window.clearTimeout(initialRevealTimerRef.current)
        initialRevealTimerRef.current = null
      }
      if (messages.length === 0) {
        setHasInitialMessages(false)
      } else if (!isLoadingMessages) {
        setHasInitialMessages(true)
      }
    }
  }, [currentSessionId, messages.length, isLoadingMessages])

  useEffect(() => {
    if (currentSessionId && isConnected && messages.length === 0 && !isLoadingMessages && !isLoadingMore && !noMessageTable) {
      if (pendingSessionLoadRef.current === currentSessionId) return
      if (initialLoadRequestedSessionRef.current === currentSessionId) return
      initialLoadRequestedSessionRef.current = currentSessionId
      setHasInitialMessages(false)
      void loadMessages(currentSessionId, 0, 0, 0, false, {
        preferLatestPath: true,
        deferGroupSenderWarmup: true,
        forceInitialLimit: 30
      })
    }
  }, [currentSessionId, isConnected, messages.length, isLoadingMessages, isLoadingMore, noMessageTable])

  useEffect(() => {
    return () => {
      if (initialRevealTimerRef.current !== null) {
        window.clearTimeout(initialRevealTimerRef.current)
        initialRevealTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    isConnectedRef.current = isConnected
  }, [isConnected])

  useEffect(() => {
    const replayKeyword = pendingGlobalMsgSearchReplayRef.current
    if (!replayKeyword || !isConnected || sessions.length === 0) return
    pendingGlobalMsgSearchReplayRef.current = null
    void handleGlobalMsgSearch(replayKeyword)
  }, [isConnected, sessions.length, handleGlobalMsgSearch])

  useEffect(() => {
    return () => {
      inSessionSearchGenRef.current += 1
      if (inSessionSearchTimerRef.current) {
        clearTimeout(inSessionSearchTimerRef.current)
        inSessionSearchTimerRef.current = null
      }
      globalMsgSearchGenRef.current += 1
      if (globalMsgSearchTimerRef.current) {
        clearTimeout(globalMsgSearchTimerRef.current)
        globalMsgSearchTimerRef.current = null
      }
      globalMsgPrefixCacheRef.current = null
    }
  }, [])

  useEffect(() => {
    searchKeywordRef.current = searchKeyword
  }, [searchKeyword])

  useEffect(() => {
    if (!showJumpPopover) return
    const handleGlobalPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (jumpCalendarWrapRef.current?.contains(target)) return
      if (jumpPopoverPortalRef.current?.contains(target)) return
      setShowJumpPopover(false)
    }
    document.addEventListener('mousedown', handleGlobalPointerDown)
    return () => {
      document.removeEventListener('mousedown', handleGlobalPointerDown)
    }
  }, [showJumpPopover])

  useEffect(() => {
    if (!showJumpPopover) return
    const syncPosition = () => {
      requestAnimationFrame(() => updateJumpPopoverPosition())
    }

    syncPosition()
    window.addEventListener('resize', syncPosition)
    window.addEventListener('scroll', syncPosition, true)
    return () => {
      window.removeEventListener('resize', syncPosition)
      window.removeEventListener('scroll', syncPosition, true)
    }
  }, [showJumpPopover, updateJumpPopoverPosition])

  useEffect(() => {
    setShowJumpPopover(false)
    setLoadingDates(false)
    setLoadingDateCounts(false)
    setHasLoadedMessageDates(false)
    setMessageDates(new Set())
    setMessageDateCounts({})
  }, [currentSessionId])

  useEffect(() => {
    if (!currentSessionId || !Array.isArray(messages) || messages.length === 0) return
    persistSessionPreviewCache(currentSessionId, messages)
    saveSessionWindowCache(currentSessionId, {
      messages,
      currentOffset,
      hasMoreMessages,
      hasMoreLater,
      jumpStartTime,
      jumpEndTime
    })
  }, [
    currentSessionId,
    messages,
    currentOffset,
    hasMoreMessages,
    hasMoreLater,
    jumpStartTime,
    jumpEndTime,
    persistSessionPreviewCache,
    saveSessionWindowCache
  ])

  useEffect(() => {
    return () => {
      inSessionResultJumpRequestSeqRef.current += 1
      if (inSessionResultJumpTimerRef.current) {
        window.clearTimeout(inSessionResultJumpTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!Array.isArray(sessions) || sessions.length === 0) return
    if (sessionListPersistTimerRef.current !== null) {
      window.clearTimeout(sessionListPersistTimerRef.current)
    }
    sessionListPersistTimerRef.current = window.setTimeout(() => {
      persistSessionListCache(chatCacheScopeRef.current, sessions)
      sessionListPersistTimerRef.current = null
    }, 260)
  }, [sessions, persistSessionListCache])

  // 普通视图：隐藏 isFolded 的群，保留 placeholder_foldgroup 入口
  const filteredSessions = useMemo(() => {
    if (!Array.isArray(sessions)) {
      return []
    }

    // 检查是否有折叠的群聊
    const foldedGroups = sessions.filter(s => s.isFolded && !s.username.toLowerCase().includes('placeholder_foldgroup'))
    const hasFoldedGroups = foldedGroups.length > 0

    let visible = sessions.filter(s => {
      if (s.isFolded && !s.username.toLowerCase().includes('placeholder_foldgroup')) return false
      return true
    })

    const bizEntry: ChatSession = {
      username: OFFICIAL_ACCOUNTS_VIRTUAL_ID,
      displayName: '公众号',
      summary: '查看公众号历史消息',
      type: 0,
      sortTimestamp: 9999999999,  // 放到最前面？  目前还没有严格的对时间进行排序，  后面可以改一下
      lastTimestamp: 0,
      lastMsgType: 0,
      unreadCount: 0,
      isMuted: false,
      isFolded: false
    }

    if (!visible.some(s => s.username === OFFICIAL_ACCOUNTS_VIRTUAL_ID)) {
      visible.unshift(bizEntry)
    }

    if (hasFoldedGroups && !visible.some(s => s.username.toLowerCase().includes('placeholder_foldgroup'))) {

      const latestFolded = foldedGroups.reduce((latest, current) => {
        const latestTime = latest.sortTimestamp || latest.lastTimestamp
        const currentTime = current.sortTimestamp || current.lastTimestamp
        return currentTime > latestTime ? current : latest
      })

      const foldEntry: ChatSession = {
        username: 'placeholder_foldgroup',
        displayName: '折叠的聊天',
        summary: `${latestFolded.displayName || latestFolded.username}: ${latestFolded.summary}`,
        type: 0,
        sortTimestamp: latestFolded.sortTimestamp || latestFolded.lastTimestamp,
        lastTimestamp: latestFolded.lastTimestamp || latestFolded.sortTimestamp,
        lastMsgType: 0,
        unreadCount: foldedGroups.reduce((sum, s) => sum + (s.unreadCount || 0), 0),
        isMuted: false,
        isFolded: false
      }

      // 按时间戳插入到正确位置
      const foldTime = foldEntry.sortTimestamp || foldEntry.lastTimestamp
      const insertIndex = visible.findIndex(s => {
        const sTime = s.sortTimestamp || s.lastTimestamp
        return sTime < foldTime
      })
      if (insertIndex === -1) {
        visible.push(foldEntry)
      } else {
        visible.splice(insertIndex, 0, foldEntry)
      }
    }

    if (!searchKeyword.trim()) {
      return visible
    }
    const lower = searchKeyword.toLowerCase()
    return visible
      .filter(s => {
        const matchedByName = s.displayName?.toLowerCase().includes(lower)
        const matchedByUsername = s.username.toLowerCase().includes(lower)
        const matchedByAlias = s.alias?.toLowerCase().includes(lower)
        return matchedByName || matchedByUsername || matchedByAlias
      })
      .map(s => {
        const matchedByName = s.displayName?.toLowerCase().includes(lower)
        const matchedByUsername = s.username.toLowerCase().includes(lower)
        const matchedByAlias = s.alias?.toLowerCase().includes(lower)

        let matchedField: 'wxid' | 'alias' | 'name' | undefined = undefined

        if (matchedByUsername && !matchedByName && !matchedByAlias) {
          matchedField = 'wxid'
        } else if (matchedByAlias && !matchedByName && !matchedByUsername) {
          matchedField = 'alias'
        } else if (matchedByName && !matchedByUsername && !matchedByAlias) {
          matchedField = 'name'
        }

        return { ...s, matchedField }
      })
  }, [sessions, searchKeyword])

  // 折叠群列表（独立计算，供折叠 panel 使用）
  const foldedSessions = useMemo(() => {
    if (!Array.isArray(sessions)) return []
    const folded = sessions.filter(s => s.isFolded)
    if (!searchKeyword.trim() || !foldedView) return folded
    const lower = searchKeyword.toLowerCase()
    return folded
        // 1. 先过滤
        .filter(s => {
          const matchedByName = s.displayName?.toLowerCase().includes(lower)
          const matchedByUsername = s.username.toLowerCase().includes(lower)
          const matchedByAlias = s.alias?.toLowerCase().includes(lower)
          const matchedBySummary = s.summary?.toLowerCase().includes(lower) // 注意：这里有个 summary

          return matchedByName || matchedByUsername || matchedByAlias || matchedBySummary
        })
        // 2. 后映射
        .map(s => {
          const matchedByName = s.displayName?.toLowerCase().includes(lower)
          const matchedByUsername = s.username.toLowerCase().includes(lower)
          const matchedByAlias = s.alias?.toLowerCase().includes(lower)
          const matchedBySummary = s.summary?.toLowerCase().includes(lower)

          let matchedField: 'wxid' | 'alias' | 'name' | undefined = undefined

          if (matchedByUsername && !matchedByName && !matchedBySummary && !matchedByAlias) {
            matchedField = 'wxid'
          } else if (matchedByAlias && !matchedByName && !matchedBySummary && !matchedByUsername) {
            matchedField = 'alias'
          }

          // ✅ 同样返回新对象
          return { ...s, matchedField }
        })
  }, [sessions, searchKeyword, foldedView])

  const sessionLookupMap = useMemo(() => {
    const map = new Map<string, ChatSession>()
    for (const session of sessions) {
      const username = String(session.username || '').trim()
      if (!username) continue
      map.set(username, session)
    }
    return map
  }, [sessions])
  const groupedGlobalMsgResults = useMemo(() => {
    const grouped = globalMsgResults.reduce((acc, msg) => {
      const sessionId = (msg as any).sessionId || '未知'
      if (!acc[sessionId]) acc[sessionId] = []
      acc[sessionId].push(msg)
      return acc
    }, {} as Record<string, Message[]>)
    return Object.entries(grouped)
  }, [globalMsgResults])

  const hasSessionRecords = Array.isArray(sessions) && sessions.length > 0
  const shouldShowSessionsSkeleton = isLoadingSessions && !hasSessionRecords
  const isSessionListSyncing = (isLoadingSessions || isRefreshingSessions) && hasSessionRecords


  // 格式化会话时间（相对时间）- 使用 useMemo 缓存，避免每次渲染都计算
  const formatSessionTime = useCallback((timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return ''

    const now = Date.now()
    const msgTime = timestamp * 1000
    const diff = now - msgTime

    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)

    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes}分钟前`
    if (hours < 24) return `${hours}小时前`

    // 超过24小时显示日期
    const date = new Date(msgTime)
    const nowDate = new Date()

    if (date.getFullYear() === nowDate.getFullYear()) {
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }, [])

  // 获取当前会话信息（从通讯录跳转时可能不在 sessions 列表中，构造 fallback）
  const currentSession = (() => {
    const found = Array.isArray(sessions) ? sessions.find(s => s.username === currentSessionId) : undefined
    if (found) {
      if (
        standaloneSessionWindow &&
        normalizedInitialSessionId &&
        found.username === normalizedInitialSessionId
      ) {
        return {
          ...found,
          displayName: found.displayName || fallbackDisplayName || found.username,
          avatarUrl: found.avatarUrl || fallbackAvatarUrl || undefined
        }
      }
      return found
    }
    if (!currentSessionId) return found
    return {
      username: currentSessionId,
      type: 0,
      unreadCount: 0,
      summary: '',
      sortTimestamp: 0,
      lastTimestamp: 0,
      lastMsgType: 0,
      displayName: fallbackDisplayName || currentSessionId,
      avatarUrl: fallbackAvatarUrl || undefined,
    } as ChatSession
  })()
  const filteredGroupPanelMembers = useMemo(() => {
    const keyword = groupMemberSearchKeyword.trim().toLowerCase()
    if (!keyword) return groupPanelMembers
    return groupPanelMembers.filter((member) => {
      const fields = [
        member.username,
        member.displayName,
        member.groupNickname,
        member.remark,
        member.nickname,
        member.alias
      ]
      return fields.some(field => String(field || '').toLowerCase().includes(keyword))
    })
  }, [groupMemberSearchKeyword, groupPanelMembers])
  const isCurrentSessionExporting = Boolean(currentSessionId && inProgressExportSessionIds.has(currentSessionId))
  const isExportActionBusy = isCurrentSessionExporting || isPreparingExportDialog
  const isCurrentSessionGroup = Boolean(
    currentSession && (
      isGroupChatSession(currentSession.username) ||
      (
        standaloneSessionWindow &&
        currentSession.username === normalizedInitialSessionId &&
        normalizedStandaloneInitialContactType === 'group'
      )
    )
  )
  const isCurrentSessionPrivateSnsSupported = Boolean(
    currentSession &&
    isSingleContactSession(currentSession.username) &&
    !isCurrentSessionGroup
  )

  const openCurrentSessionSnsTimeline = useCallback(() => {
    if (!currentSession || !isCurrentSessionPrivateSnsSupported) return
    setChatSnsTimelineTarget({
      username: currentSession.username,
      displayName: currentSession.displayName || currentSession.username,
      avatarUrl: currentSession.avatarUrl
    })
  }, [currentSession, isCurrentSessionPrivateSnsSupported])

  useEffect(() => {
    if (!standaloneSessionWindow) return
    setStandaloneInitialLoadRequested(false)
    setStandaloneLoadStage(normalizedInitialSessionId ? 'connecting' : 'idle')
    setFallbackDisplayName(normalizedStandaloneInitialDisplayName || null)
    setFallbackAvatarUrl(normalizedStandaloneInitialAvatarUrl || null)
  }, [
    standaloneSessionWindow,
    normalizedInitialSessionId,
    normalizedStandaloneInitialDisplayName,
    normalizedStandaloneInitialAvatarUrl
  ])

  useEffect(() => {
    if (!standaloneSessionWindow) return
    if (!normalizedInitialSessionId) return

    if (normalizedStandaloneInitialDisplayName) {
      setFallbackDisplayName(normalizedStandaloneInitialDisplayName)
    }
    if (normalizedStandaloneInitialAvatarUrl) {
      setFallbackAvatarUrl(normalizedStandaloneInitialAvatarUrl)
    }

    if (!currentSessionId) {
      setCurrentSession(normalizedInitialSessionId, { preserveMessages: false })
    }
    if (!isConnected || isConnecting) {
      setStandaloneLoadStage('connecting')
    }
  }, [
    standaloneSessionWindow,
    normalizedInitialSessionId,
    normalizedStandaloneInitialDisplayName,
    normalizedStandaloneInitialAvatarUrl,
    currentSessionId,
    isConnected,
    isConnecting,
    setCurrentSession
  ])

  useEffect(() => {
    if (!standaloneSessionWindow) return
    if (!normalizedInitialSessionId) return
    if (!isConnected || isConnecting) return
    if (currentSessionId === normalizedInitialSessionId && standaloneInitialLoadRequested) return
    setStandaloneInitialLoadRequested(true)
    setStandaloneLoadStage('loading')
    selectSessionById(normalizedInitialSessionId, {
      force: currentSessionId === normalizedInitialSessionId
    })
  }, [
    standaloneSessionWindow,
    normalizedInitialSessionId,
    isConnected,
    isConnecting,
    currentSessionId,
    standaloneInitialLoadRequested,
    selectSessionById
  ])

  useEffect(() => {
    if (!standaloneSessionWindow || !normalizedInitialSessionId) return
    if (!isConnected || isConnecting) {
      setStandaloneLoadStage('connecting')
      return
    }
    if (!standaloneInitialLoadRequested) {
      setStandaloneLoadStage('loading')
      return
    }
    if (currentSessionId !== normalizedInitialSessionId) {
      setStandaloneLoadStage('loading')
      return
    }
    if (isLoadingMessages || isSessionSwitching) {
      setStandaloneLoadStage('loading')
      return
    }
    setStandaloneLoadStage('ready')
  }, [
    standaloneSessionWindow,
    normalizedInitialSessionId,
    isConnected,
    isConnecting,
    standaloneInitialLoadRequested,
    currentSessionId,
    isLoadingMessages,
    isSessionSwitching
  ])

  // 从通讯录跳转时，会话不在列表中，主动加载联系人显示名称
  useEffect(() => {
    if (!currentSessionId) return
    const found = Array.isArray(sessions) ? sessions.find(s => s.username === currentSessionId) : undefined
    if (found) {
      if (found.displayName) setFallbackDisplayName(found.displayName)
      if (found.avatarUrl) setFallbackAvatarUrl(found.avatarUrl)
      return
    }
    loadContactInfoBatch([currentSessionId]).then(() => {
      const cached = senderAvatarCache.get(currentSessionId)
      if (cached?.displayName) setFallbackDisplayName(cached.displayName)
      if (cached?.avatarUrl) setFallbackAvatarUrl(cached.avatarUrl)
    })
  }, [currentSessionId, sessions])

  // 渲染日期分隔
  const shouldShowDateDivider = (msg: Message, prevMsg?: Message): boolean => {
    if (!prevMsg) return true
    const date = new Date(msg.createTime * 1000).toDateString()
    const prevDate = new Date(prevMsg.createTime * 1000).toDateString()
    return date !== prevDate
  }

  const formatDateDivider = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '未知时间'
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()

    if (isToday) return '今天'

    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (date.toDateString() === yesterday.toDateString()) return '昨天'

    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  const handleRequireModelDownload = useCallback((sessionId: string, messageId: string) => {
    setPendingVoiceTranscriptRequest({ sessionId, messageId })
    setShowVoiceTranscribeDialog(true)
  }, [])

  // 批量语音转文字
  const handleBatchTranscribe = useCallback(async () => {
    if (!currentSessionId) return
    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) {
      alert('未找到当前会话')
      return
    }
    if (isBatchTranscribing) return

    const result = await window.electronAPI.chat.getAllVoiceMessages(currentSessionId)
    if (!result.success || !result.messages) {
      alert(`获取语音消息失败: ${result.error || '未知错误'}`)
      return
    }

    const voiceMessages: Message[] = result.messages
    if (voiceMessages.length === 0) {
      alert('当前会话没有语音消息')
      return
    }

    const dateSet = new Set<string>()
    voiceMessages.forEach(m => dateSet.add(new Date(m.createTime * 1000).toISOString().slice(0, 10)))
    const sortedDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a))

    setBatchVoiceMessages(voiceMessages)
    setBatchVoiceCount(voiceMessages.length)
    setBatchVoiceDates(sortedDates)
    setBatchSelectedDates(new Set(sortedDates))
    setBatchVoiceTaskType('transcribe')
    setShowBatchConfirm(true)
  }, [sessions, currentSessionId, isBatchTranscribing])

  const handleBatchDecrypt = useCallback(async () => {
    if (!currentSessionId || isBatchDecrypting) return
    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) {
      alert('未找到当前会话')
      return
    }

    const result = await window.electronAPI.chat.getAllImageMessages(currentSessionId)
    if (!result.success || !result.images) {
      alert(`获取图片消息失败: ${result.error || '未知错误'}`)
      return
    }

    if (result.images.length === 0) {
      alert('当前会话没有图片消息')
      return
    }

    const dateSet = new Set<string>()
    result.images.forEach((img: BatchImageDecryptCandidate) => {
      if (img.createTime) dateSet.add(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    })
    const sortedDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a))

    setBatchImageMessages(result.images)
    setBatchImageDates(sortedDates)
    setBatchImageSelectedDates(new Set(sortedDates))
    setShowBatchDecryptConfirm(true)
  }, [currentSessionId, isBatchDecrypting, sessions])

  const handleExportCurrentSession = useCallback(() => {
    if (!currentSessionId) return
    if (inProgressExportSessionIds.has(currentSessionId) || isPreparingExportDialog) return

    const requestId = `chat-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sessionName = currentSession?.displayName || currentSession?.username || currentSessionId
    pendingExportRequestIdRef.current = requestId
    setIsPreparingExportDialog(true)
    setExportPrepareHint('')
    if (exportPrepareLongWaitTimerRef.current) {
      window.clearTimeout(exportPrepareLongWaitTimerRef.current)
      exportPrepareLongWaitTimerRef.current = null
    }
    emitOpenSingleExport({
      sessionId: currentSessionId,
      sessionName,
      requestId
    })
  }, [currentSession, currentSessionId, inProgressExportSessionIds, isPreparingExportDialog])

  const handleGroupAnalytics = useCallback(() => {
    if (!currentSessionId || !isGroupChatSession(currentSessionId)) return
    navigate('/analytics/group', {
      state: {
        preselectGroupIds: [currentSessionId]
      }
    })
  }, [currentSessionId, navigate, isGroupChatSession])

  // 确认批量语音任务（解密/转写）
  const confirmBatchTranscribe = useCallback(async () => {
    if (!currentSessionId) return

    const selected = batchSelectedDates
    if (selected.size === 0) {
      alert('请至少选择一个日期')
      return
    }

    const messages = batchVoiceMessages
    if (!messages || messages.length === 0) {
      setShowBatchConfirm(false)
      return
    }

    const voiceMessages = messages.filter(m =>
      selected.has(new Date(m.createTime * 1000).toISOString().slice(0, 10))
    )
    if (voiceMessages.length === 0) {
      alert('所选日期下没有语音消息')
      return
    }

    setShowBatchConfirm(false)
    setBatchVoiceMessages(null)
    setBatchVoiceDates([])
    setBatchSelectedDates(new Set())

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) return

    const taskType = batchVoiceTaskType
    startTranscribe(voiceMessages.length, session.displayName || session.username, taskType)

    if (taskType === 'transcribe') {
      // 检查模型状态
      const modelStatus = await window.electronAPI.whisper.getModelStatus()
      if (!modelStatus?.exists) {
        alert('SenseVoice 模型未下载，请先在设置中下载模型')
        finishTranscribe(0, 0)
        return
      }
    }

    let successCount = 0
    let failCount = 0
    let completedCount = 0
    const concurrency = taskType === 'decrypt' ? 12 : 10

    const runOne = async (msg: Message) => {
      try {
        if (taskType === 'decrypt') {
          const result = await window.electronAPI.chat.getVoiceData(
            session.username,
            String(msg.localId),
            msg.createTime,
            msg.serverIdRaw || msg.serverId
          )
          return { success: Boolean(result.success && result.data) }
        }
        const result = await window.electronAPI.chat.getVoiceTranscript(
          session.username,
          String(msg.localId),
          msg.createTime
        )
        return { success: result.success }
      } catch {
        return { success: false }
      }
    }

    for (let i = 0; i < voiceMessages.length; i += concurrency) {
      const batch = voiceMessages.slice(i, i + concurrency)
      const results = await Promise.all(batch.map(msg => runOne(msg)))

      results.forEach(result => {
        if (result.success) successCount++
        else failCount++
        completedCount++
        updateProgress(completedCount, voiceMessages.length)
      })
    }

    finishTranscribe(successCount, failCount)
  }, [sessions, currentSessionId, batchSelectedDates, batchVoiceMessages, batchVoiceTaskType, startTranscribe, updateProgress, finishTranscribe])

  // 批量转写：按日期的消息数量
  const batchCountByDate = useMemo(() => {
    const map = new Map<string, number>()
    if (!batchVoiceMessages) return map
    batchVoiceMessages.forEach(m => {
      const d = new Date(m.createTime * 1000).toISOString().slice(0, 10)
      map.set(d, (map.get(d) || 0) + 1)
    })
    return map
  }, [batchVoiceMessages])

  // 批量转写：选中日期对应的语音条数
  const batchSelectedMessageCount = useMemo(() => {
    if (!batchVoiceMessages) return 0
    return batchVoiceMessages.filter(m =>
      batchSelectedDates.has(new Date(m.createTime * 1000).toISOString().slice(0, 10))
    ).length
  }, [batchVoiceMessages, batchSelectedDates])

  const batchVoiceTaskTitle = batchVoiceTaskType === 'decrypt' ? '批量解密语音' : '批量语音转文字'
  const batchVoiceTaskVerb = batchVoiceTaskType === 'decrypt' ? '解密' : '转写'
  const batchVoiceTaskMinutes = Math.ceil(
    batchSelectedMessageCount * (batchVoiceTaskType === 'decrypt' ? 0.6 : 2) / 60
  )

  const toggleBatchDate = useCallback((date: string) => {
    setBatchSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])
  const selectAllBatchDates = useCallback(() => setBatchSelectedDates(new Set(batchVoiceDates)), [batchVoiceDates])
  const clearAllBatchDates = useCallback(() => setBatchSelectedDates(new Set()), [])

  const confirmBatchDecrypt = useCallback(async () => {
    if (!currentSessionId) return

    const selected = batchImageSelectedDates
    if (selected.size === 0) {
      alert('请至少选择一个日期')
      return
    }

    const images = (batchImageMessages || []).filter(img =>
      img.createTime && selected.has(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    )
    if (images.length === 0) {
      alert('所选日期下没有图片消息')
      return
    }

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) return

    setShowBatchDecryptConfirm(false)
    setBatchImageMessages(null)
    setBatchImageDates([])
    setBatchImageSelectedDates(new Set())

    startDecrypt(images.length, session.displayName || session.username)

    let successCount = 0
    let failCount = 0
    let completed = 0
    const concurrency = batchDecryptConcurrency

    const decryptOne = async (img: typeof images[0]) => {
      try {
        const r = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: img.imageMd5,
          imageDatName: img.imageDatName,
          force: true
        })
        if (r?.success) successCount++
        else failCount++
      } catch {
        failCount++
      }
      completed++
      updateDecryptProgress(completed, images.length)
    }

    // 并发池：同时跑 concurrency 个任务
    const pool = new Set<Promise<void>>()
    for (const img of images) {
      const p = decryptOne(img).then(() => { pool.delete(p) })
      pool.add(p)
      if (pool.size >= concurrency) {
        await Promise.race(pool)
      }
    }
    if (pool.size > 0) {
      await Promise.all(pool)
    }

    finishDecrypt(successCount, failCount)
  }, [batchImageMessages, batchImageSelectedDates, batchDecryptConcurrency, currentSessionId, finishDecrypt, sessions, startDecrypt, updateDecryptProgress])

  const batchImageCountByDate = useMemo(() => {
    const map = new Map<string, number>()
    if (!batchImageMessages) return map
    batchImageMessages.forEach(img => {
      if (!img.createTime) return
      const d = new Date(img.createTime * 1000).toISOString().slice(0, 10)
      map.set(d, (map.get(d) ?? 0) + 1)
    })
    return map
  }, [batchImageMessages])

  const batchImageSelectedCount = useMemo(() => {
    if (!batchImageMessages) return 0
    return batchImageMessages.filter(img =>
      img.createTime && batchImageSelectedDates.has(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    ).length
  }, [batchImageMessages, batchImageSelectedDates])

  const toggleBatchImageDate = useCallback((date: string) => {
    setBatchImageSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])
  const selectAllBatchImageDates = useCallback(() => setBatchImageSelectedDates(new Set(batchImageDates)), [batchImageDates])
  const clearAllBatchImageDates = useCallback(() => setBatchImageSelectedDates(new Set()), [])

  const lastSelectedKeyRef = useRef<string | null>(null)

  const handleToggleSelection = useCallback((messageKey: string, isShiftKey: boolean = false) => {
    setSelectedMessages(prev => {
      const next = new Set(prev)

      // Range selection with Shift key
      if (isShiftKey && lastSelectedKeyRef.current !== null && lastSelectedKeyRef.current !== messageKey) {
        const currentMsgs = useChatStore.getState().messages || []
        const idx1 = currentMsgs.findIndex(m => getMessageKey(m) === lastSelectedKeyRef.current)
        const idx2 = currentMsgs.findIndex(m => getMessageKey(m) === messageKey)

        if (idx1 !== -1 && idx2 !== -1) {
          const start = Math.min(idx1, idx2)
          const end = Math.max(idx1, idx2)
          for (let i = start; i <= end; i++) {
            next.add(getMessageKey(currentMsgs[i]))
          }
        }
      } else {
        // Normal toggle
        if (next.has(messageKey)) {
          next.delete(messageKey)
          lastSelectedKeyRef.current = null
        } else {
          next.add(messageKey)
          lastSelectedKeyRef.current = messageKey
        }
      }
      return next
    })
  }, [getMessageKey])

  const formatBatchDateLabel = useCallback((dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number)
    return `${y}年${m}月${d}日`
  }, [])

  const clampContextMenuPosition = useCallback((x: number, y: number) => {
    const viewportPadding = 12
    const estimatedMenuWidth = 180
    const estimatedMenuHeight = 188
    const maxLeft = Math.max(viewportPadding, window.innerWidth - estimatedMenuWidth - viewportPadding)
    const maxTop = Math.max(viewportPadding, window.innerHeight - estimatedMenuHeight - viewportPadding)
    return {
      x: Math.min(Math.max(x, viewportPadding), maxLeft),
      y: Math.min(Math.max(y, viewportPadding), maxTop)
    }
  }, [])

  // 消息右键菜单处理
  const handleContextMenu = useCallback((e: React.MouseEvent, message: Message) => {
    e.preventDefault()
    const nextPos = clampContextMenuPosition(e.clientX, e.clientY)
    setContextMenu({
      x: nextPos.x,
      y: nextPos.y,
      message
    })
  }, [clampContextMenuPosition])

  // 关闭右键菜单
  useEffect(() => {
    const handleClick = () => {
      setContextMenu(null)
    }
    window.addEventListener('click', handleClick)
    return () => {
      window.removeEventListener('click', handleClick)
    }
  }, [])

  // 删除消息 - 触发确认弹窗
  const handleDelete = useCallback((target: { message: Message } | null = null) => {
    const msg = target?.message || contextMenu?.message
    if (!currentSessionId || !msg) return

    setDeleteConfirm({
      show: true,
      mode: 'single',
      message: msg
    })
    setContextMenu(null)
  }, [contextMenu, currentSessionId])

  // 执行单条删除动作
  const performSingleDelete = async (msg: Message) => {
    try {
      const targetMessageKey = getMessageKey(msg)
      const dbPathHint = msg._db_path
      const result = await (window as any).electronAPI.chat.deleteMessage(currentSessionId, msg.localId, msg.createTime, dbPathHint)
      if (result.success) {
        const currentMessages = useChatStore.getState().messages || []
        const newMessages = currentMessages.filter(m => getMessageKey(m) !== targetMessageKey)
        useChatStore.getState().setMessages(newMessages)
      } else {
        alert('删除失败: ' + (result.error || '原因未知'))
      }
    } catch (e) {
      console.error(e)
      alert('删除异常: ' + String(e))
    }
  }

  // 修改消息
  const handleEditMessage = useCallback(() => {
    if (contextMenu) {
      // 允许编辑所有类型的消息
      // 如果是文本消息(1)，使用 parsedContent
      // 如果是其他类型(如系统消息 10000)，使用 rawContent 或 content 作为 XML 源码编辑
      const isText = contextMenu.message.localType === 1
      const rawXml = contextMenu.message.content || (contextMenu.message as any).rawContent || contextMenu.message.parsedContent || ''

      const contentToEdit = isText
        ? cleanMessageContent(contextMenu.message.parsedContent)
        : rawXml

      if (!isText) {
        const fields = parseXmlToFields(rawXml)
        setTempFields(fields)
        setEditMode(fields.length > 0 ? 'fields' : 'raw')
      } else {
        setEditMode('raw')
        setTempFields([])
      }

      setEditingMessage({
        message: contextMenu.message,
        content: contentToEdit
      })
      setContextMenu(null)
    }
  }, [contextMenu])

  // 确认修改消息
  const handleSaveEdit = useCallback(async () => {
    if (editingMessage && currentSessionId) {
      let finalContent = editingMessage.content

      // 如果是字段编辑模式，先同步回 XML
      if (editMode === 'fields' && tempFields.length > 0) {
        finalContent = updateXmlWithFields(editingMessage.content, tempFields)
      }

      if (!finalContent.trim()) {
        handleDelete({ message: editingMessage.message })
        setEditingMessage(null)
        return
      }

      try {
        const result = await (window as any).electronAPI.chat.updateMessage(currentSessionId, editingMessage.message.localId, editingMessage.message.createTime, finalContent)
        if (result.success) {
          const currentMessages = useChatStore.getState().messages || []
          const newMessages = currentMessages.map(m => {
            if (getMessageKey(m) === getMessageKey(editingMessage.message)) {
              return { ...m, parsedContent: finalContent, content: finalContent, rawContent: finalContent }
            }
            return m
          })
          useChatStore.getState().setMessages(newMessages)
          setEditingMessage(null)
        } else {
          alert('修改失败: ' + result.error)
        }
      } catch (e) {
        alert('修改异常: ' + String(e))
      }
    }
  }, [editingMessage, currentSessionId, editMode, tempFields, handleDelete])

  // 用于在异步循环中获取最新的取消状态
  const cancelDeleteRef = useRef(false)

  const handleBatchDelete = () => {
    if (selectedMessages.size === 0) {
      alert('请先选择要删除的消息')
      return
    }
    if (!currentSessionId) return

    setDeleteConfirm({
      show: true,
      mode: 'batch',
      count: selectedMessages.size
    })
  }

  const performBatchDelete = async () => {
    setIsDeleting(true)
    setDeleteProgress({ current: 0, total: selectedMessages.size })
    setCancelDeleteRequested(false)
    cancelDeleteRef.current = false

    try {
      const currentMessages = useChatStore.getState().messages || []
      const selectedKeys = Array.from(selectedMessages)
      const deletedKeys = new Set<string>()

      for (let i = 0; i < selectedKeys.length; i++) {
        if (cancelDeleteRef.current) break

        const key = selectedKeys[i]
        const msgObj = currentMessages.find(m => getMessageKey(m) === key)
        const dbPathHint = msgObj?._db_path
        const createTime = msgObj?.createTime || 0
        const localId = msgObj?.localId || 0

        if (!msgObj) {
          setDeleteProgress({ current: i + 1, total: selectedKeys.length })
          continue
        }

        try {
          const result = await (window as any).electronAPI.chat.deleteMessage(currentSessionId, localId, createTime, dbPathHint)
          if (result.success) {
            deletedKeys.add(key)
          }
        } catch (err) {
          console.error(`删除消息 ${localId} 失败:`, err)
        }

        setDeleteProgress({ current: i + 1, total: selectedKeys.length })
      }

      const finalMessages = (useChatStore.getState().messages || []).filter(m => !deletedKeys.has(getMessageKey(m)))
      useChatStore.getState().setMessages(finalMessages)

      setIsSelectionMode(false)
      setSelectedMessages(new Set<string>())
      lastSelectedKeyRef.current = null

      if (cancelDeleteRef.current) {
        alert(`操作已中止。已删除 ${deletedKeys.size} 条，剩余记录保留。`)
      }
    } catch (e) {
      alert('批量删除出现错误: ' + String(e))
      console.error(e)
    } finally {
      setIsDeleting(false)
      setCancelDeleteRequested(false)
      cancelDeleteRef.current = false
    }
  }

  const messageVirtuosoComponents = useMemo(() => ({
    Header: () => (
      hasMoreMessages ? (
        <div className={`load-more-trigger ${isLoadingMore ? 'loading' : ''}`}>
          {isLoadingMore ? (
            <>
              <Loader2 size={14} />
              <span>加载更多...</span>
            </>
          ) : (
            <span>向上滚动加载更多</span>
          )}
        </div>
      ) : null
    ),
    Footer: () => (
      hasMoreLater ? (
        <div className={`load-more-trigger later ${isLoadingMore ? 'loading' : ''}`}>
          {isLoadingMore ? (
            <>
              <Loader2 size={14} />
              <span>正在加载后续消息...</span>
            </>
          ) : (
            <span>向下滚动查看更新消息</span>
          )}
        </div>
      ) : null
    )
  }), [hasMoreMessages, hasMoreLater, isLoadingMore])

  const renderMessageListItem = useCallback((index: number, msg: Message) => {
    if (!currentSession) return null

    const prevMsg = index > 0 ? messages[index - 1] : undefined
    const showDateDivider = shouldShowDateDivider(msg, prevMsg)
    const showTime = !prevMsg || (msg.createTime - prevMsg.createTime > 300)
    const isSent = msg.isSend === 1
    const isSystem = isSystemMessage(msg.localType)
    const wrapperClass = isSystem ? 'system' : (isSent ? 'sent' : 'received')
    const messageKey = getMessageKey(msg)

    return (
      <div className={`message-wrapper ${wrapperClass} ${highlightedMessageSet.has(messageKey) ? 'new-message' : ''}`}>
        {showDateDivider && (
          <div className="date-divider">
            <span>{formatDateDivider(msg.createTime)}</span>
          </div>
        )}
        <MemoMessageBubble
          message={msg}
          session={currentSession!}
          showTime={!showDateDivider && showTime}
          myAvatarUrl={myAvatarUrl}
          myWxid={myWxid}
          isGroupChat={isCurrentSessionGroup}
          autoTranscribeVoiceEnabled={autoTranscribeVoiceEnabled}
          onRequireModelDownload={handleRequireModelDownload}
          onContextMenu={handleContextMenu}
          isSelectionMode={isSelectionMode}
          messageKey={messageKey}
          isSelected={selectedMessages.has(messageKey)}
          onToggleSelection={handleToggleSelection}
        />
      </div>
    )
  }, [
    messages,
    highlightedMessageSet,
    getMessageKey,
    formatDateDivider,
    currentSession,
    myAvatarUrl,
    myWxid,
    isCurrentSessionGroup,
    autoTranscribeVoiceEnabled,
    handleRequireModelDownload,
    handleContextMenu,
    isSelectionMode,
    selectedMessages,
    handleToggleSelection
  ])

  return (
    <div className={`chat-page ${isResizing ? 'resizing' : ''} ${standaloneSessionWindow ? 'standalone session-only' : ''}`}>
      {/* 自定义删除确认对话框 */}
      {deleteConfirm.show && (
        <div className="delete-confirm-overlay">
          <div className="delete-confirm-card">
            <div className="confirm-icon">
              <Trash2 size={32} color="var(--danger)" />
            </div>
            <div className="confirm-content">
              <h3>确认删除</h3>
              <p>
                {deleteConfirm.mode === 'single'
                  ? '确定要删除这条消息吗？此操作不可恢复。'
                  : `确定要删除选中的 ${deleteConfirm.count} 条消息吗？`}
              </p>
            </div>
            <div className="confirm-actions">
              <button
                className="btn-secondary"
                onClick={() => setDeleteConfirm({ ...deleteConfirm, show: false })}
              >
                取消
              </button>
              <button
                className="btn-danger-filled"
                onClick={() => {
                  setDeleteConfirm({ ...deleteConfirm, show: false });
                  if (deleteConfirm.mode === 'single' && deleteConfirm.message) {
                    performSingleDelete(deleteConfirm.message);
                  } else if (deleteConfirm.mode === 'batch') {
                    performBatchDelete();
                  }
                }}
              >
                确定删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 批量删除进度遮罩 */}
      {isDeleting && (
        <div className="delete-progress-overlay">
          <div className="delete-progress-card">
            <div className="progress-header">
              <h3>正在彻底删除消息...</h3>
              <span className="count">{deleteProgress.current} / {deleteProgress.total}</span>
            </div>
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${(deleteProgress.current / deleteProgress.total) * 100}%` }}
              />
            </div>
            <div className="progress-footer">
              <p>请勿关闭应用或切换会话，确保所有副本都被清理。</p>
              <button
                className="cancel-delete-btn"
                onClick={() => {
                  setCancelDeleteRequested(true)
                  cancelDeleteRef.current = true
                }}
                disabled={cancelDeleteRequested}
              >
                {cancelDeleteRequested ? '正在停止...' : '中止删除'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 左侧会话列表 */}
      {!standaloneSessionWindow && (
      <div
        className="session-sidebar"
        ref={sidebarRef}
        style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}
      >
        <div className={`session-header session-header-viewport ${foldedView || bizView ? 'folded' : ''}`}>
          {/* 普通 header */}
          <div className="session-header-panel main-header">
            <div className="search-row">
              <div className="search-box expanded">
                <Search size={14} />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="搜索"
                  value={searchKeyword}
                  onChange={(e) => {
                    handleSearch(e.target.value)
                    handleGlobalMsgSearch(e.target.value)
                  }}
                />
                {searchKeyword && (
                  <button className="close-search" onClick={() => { handleCloseSearch(); handleCloseGlobalMsgSearch() }}>
                    <X size={12} />
                  </button>
                )}
              </div>
              <button className="icon-btn refresh-btn" onClick={handleRefresh} disabled={isLoadingSessions || isRefreshingSessions}>
                <RefreshCw size={16} className={(isLoadingSessions || isRefreshingSessions) ? 'spin' : ''} />
              </button>
            </div>
          </div>
          {/* 折叠群 header */}
          <div className="session-header-panel folded-header">
            <div className="folded-view-header">
              <button className="icon-btn back-btn" onClick={() => {
                setFoldedView(false)
                setBizView(false)
              }}>
                <ChevronLeft size={18} />
              </button>
              <span className="folded-view-title">
                {foldedView ? (
                    <><Users size={14} /> 折叠的群聊</>
                ) : bizView ? (
                    <><Newspaper size={14} /> 订阅号/服务号</>
                ) : null}
              </span>
            </div>
          </div>
        </div>

        {connectionError && (
          <div className="connection-error">
            <AlertCircle size={16} />
            <span>{connectionError}</span>
            <button onClick={connect}>重试</button>
          </div>
        )}

        {/* 全局消息搜索结果 */}
        {globalMsgQuery && (
          <div className="global-msg-search-results">
            {globalMsgSearchError ? (
              <div className="no-results">
                <AlertCircle size={32} />
                <p>{globalMsgSearchError}</p>
              </div>
            ) : globalMsgResults.length > 0 ? (
              <>
                <div className="search-section-header">
                  聊天记录：
                  {globalMsgSearching && (
                    <span className="search-phase-hint">
                      {globalMsgIsBackfilling
                        ? `补全中 ${globalMsgAuthoritativeSessionCount > 0 ? `(${globalMsgAuthoritativeSessionCount})` : ''}...`
                        : '搜索中...'}
                    </span>
                  )}
                  {!globalMsgSearching && globalMsgSearchPhase === 'done' && (
                    <span className="search-phase-hint done">已完成</span>
                  )}
                </div>
                <div className="search-results-list">
                  {groupedGlobalMsgResults.map(([sessionId, messages]) => {
                    const session = sessionLookupMap.get(sessionId)
                    const firstMsg = messages[0]
                    const count = messages.length
                    return (
                      <div
                        key={sessionId}
                        className="session-item"
                        onClick={() => {
                          if (session) {
                            pendingInSessionSearchRef.current = {
                              sessionId,
                              keyword: globalMsgQuery,
                              firstMsgTime: firstMsg.createTime || 0,
                              results: messages
                            }
                            handleSelectSession(session)
                          }
                        }}
                      >
                        <Avatar
                          src={session?.avatarUrl}
                          name={session?.displayName || sessionId}
                          size={48}
                        />
                        <div className="session-content">
                          <div className="session-top">
                            <span className="session-name">{session?.displayName || sessionId}</span>
                          </div>
                          <div className="session-preview">
                            <HighlightTextNoTruncate text={firstMsg.parsedContent || firstMsg.content || ''} keyword={globalMsgQuery} />
                          </div>
                          {count > 1 && (
                            <div className="search-count">共 {count} 条相关聊天记录</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : globalMsgSearching ? (
              <div className="search-loading">
                <Loader2 className="spin" size={20} />
                <span>{globalMsgSearchPhase === 'seed' ? '搜索中...' : '补全中...'}</span>
              </div>
            ) : (
              <div className="no-results">
                <MessageSquare size={32} />
                <p>未找到相关消息</p>
              </div>
            )}
          </div>
        )}

        {/* ... (previous content) ... */}
        {shouldShowSessionsSkeleton ? (
          <div className="loading-sessions">
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
        ) : (
          <div className={`session-list-viewport ${foldedView || bizView ? 'folded' : ''}`}>
            {/* 普通会话列表 */}
            <div className="session-list-panel main-panel">
              {Array.isArray(filteredSessions) && filteredSessions.length > 0 ? (
                <>
                  {searchKeyword && (
                    <div className="search-section-header">联系人：</div>
                  )}
                  <div
                    className="session-list"
                    ref={sessionListRef}
                    onScroll={() => {
                      isScrollingRef.current = true
                      if (sessionScrollTimeoutRef.current) {
                        clearTimeout(sessionScrollTimeoutRef.current)
                      }
                      sessionScrollTimeoutRef.current = window.setTimeout(() => {
                        isScrollingRef.current = false
                        sessionScrollTimeoutRef.current = null
                      }, 200)
                    }}
                  >
                    {filteredSessions.map(session => (
                    <SessionItem
                      key={session.username}
                      session={session}
                      isActive={currentSessionId === session.username || (bizView && session.username === OFFICIAL_ACCOUNTS_VIRTUAL_ID)}
                      onSelect={handleSelectSession}
                      formatTime={formatSessionTime}
                      searchKeyword={searchKeyword}
                    />
                  ))}
                </div>
                </>
              ) : (
                <div className="empty-sessions">
                  <MessageSquare />
                  <p>暂无会话</p>
                  <p className="hint">检查你的数据库配置</p>
                </div>
              )}
            </div>

            {/* 折叠群列表 */}
            <div className="session-list-panel folded-panel">
              {foldedView && (
                  foldedSessions.length > 0 ? (
                      <div className="session-list">
                        {foldedSessions.map(session => (
                            <SessionItem
                                key={session.username}
                                session={session}
                                isActive={currentSessionId === session.username || (bizView && session.username === OFFICIAL_ACCOUNTS_VIRTUAL_ID)}
                                onSelect={handleSelectSession}
                                formatTime={formatSessionTime}
                                searchKeyword={searchKeyword}
                            />
                        ))}
                      </div>
                  ) : (
                      <div className="empty-sessions">
                        <Users size={32} />
                        <p>没有折叠的群聊</p>
                      </div>
                  )
              )}

              {bizView && (
                  <div style={{ height: '100%', overflowY: 'auto' }}>
                    <BizAccountList
                        onSelect={setSelectedBizAccount}
                        selectedUsername={selectedBizAccount?.username}
                        searchKeyword={searchKeyword}
                    />
                  </div>
              )}
            </div>
          </div>
        )}
      </div>
      )}

      {!standaloneSessionWindow && <div className="resize-handle" onMouseDown={handleResizeStart} />}

      {/* 右侧消息区域 */}
      <div className="message-area">
        {bizView ? (
            <BizMessageArea account={selectedBizAccount} />
        ) : currentSession ? (
            <>
              <div className="message-header">
              <Avatar
                src={currentSession.avatarUrl}
                name={currentSession.displayName || currentSession.username}
                size={40}
                className={isCurrentSessionGroup ? 'group session-avatar' : 'session-avatar'}
              />
              <div className="header-info">
                <h3>{currentSession.displayName || currentSession.username}</h3>
                {isCurrentSessionGroup && (
                  <div className="header-subtitle">群聊</div>
                )}
              </div>
              <div className="header-actions">
                {!standaloneSessionWindow && isCurrentSessionGroup && (
                  <button
                    className="icon-btn group-analytics-btn"
                    onClick={handleGroupAnalytics}
                    title="群聊分析"
                  >
                    <BarChart3 size={18} />
                  </button>
                )}
                {isCurrentSessionGroup && (
                  <button
                    className={`icon-btn group-members-btn ${showGroupMembersPanel ? 'active' : ''}`}
                    onClick={toggleGroupMembersPanel}
                    title="群成员"
                  >
                    <Users size={18} />
                  </button>
                )}
                {!standaloneSessionWindow && (
                  <button
                    className={`icon-btn export-session-btn${isExportActionBusy ? ' exporting' : ''}`}
                    onClick={handleExportCurrentSession}
                    disabled={!currentSessionId || isExportActionBusy}
                    title={isCurrentSessionExporting ? '导出中' : isPreparingExportDialog ? '正在准备导出模块' : '导出当前会话'}
                  >
                    {isExportActionBusy ? (
                      <Loader2 size={18} className="spin" />
                    ) : (
                      <Download size={18} />
                    )}
                  </button>
                )}
                {!standaloneSessionWindow && isCurrentSessionPrivateSnsSupported && (
                  <button
                    className="icon-btn chat-sns-timeline-btn"
                    onClick={openCurrentSessionSnsTimeline}
                    disabled={!currentSessionId}
                    title="查看对方朋友圈"
                  >
                    <Aperture size={18} />
                  </button>
                )}
                {!standaloneSessionWindow && (
                  <button
                    className={`icon-btn batch-transcribe-btn${isBatchTranscribing ? ' transcribing' : ''}`}
                    onClick={() => {
                      if (isBatchTranscribing) {
                        setShowBatchProgress(true)
                      } else {
                        handleBatchTranscribe()
                      }
                    }}
                    disabled={!currentSessionId}
                    title={isBatchTranscribing
                      ? `${runningBatchVoiceTaskType === 'decrypt' ? '批量语音解密' : '批量转写'}中 (${batchTranscribeProgress.current}/${batchTranscribeProgress.total})，点击查看进度`
                      : '批量语音处理（解密/转文字）'}
                  >
                    {isBatchTranscribing ? (
                      <Loader2 size={18} className="spin" />
                    ) : (
                      <Mic size={18} />
                    )}
                  </button>
                )}
                {!standaloneSessionWindow && (
                  <button
                    className={`icon-btn batch-decrypt-btn${isBatchDecrypting ? ' transcribing' : ''}`}
                    onClick={() => {
                      if (isBatchDecrypting) {
                        setShowBatchDecryptToast(true)
                      } else {
                        handleBatchDecrypt()
                      }
                    }}
                    disabled={!currentSessionId}
                    title={isBatchDecrypting
                      ? `批量解密中 (${batchDecryptProgress.current}/${batchDecryptProgress.total})，点击查看进度`
                      : '批量解密图片'}
                  >
                    {isBatchDecrypting ? (
                      <Loader2 size={18} className="spin" />
                    ) : (
                      <ImageIcon size={18} />
                    )}
                  </button>
                )}
                <div className="jump-calendar-anchor" ref={jumpCalendarWrapRef}>
                  <button
                    className={`icon-btn jump-to-time-btn ${showJumpPopover ? 'active' : ''}`}
                    onClick={handleToggleJumpPopover}
                    title="跳转到指定时间"
                  >
                    <Calendar size={18} />
                  </button>
                </div>
                {showJumpPopover && createPortal(
                  <div
                    ref={jumpPopoverPortalRef}
                    style={{
                      position: 'fixed',
                      top: jumpPopoverPosition.top,
                      left: jumpPopoverPosition.left,
                      zIndex: 3600
                    }}
                  >
                    <JumpToDatePopover
                      isOpen={showJumpPopover}
                      currentDate={jumpPopoverDate}
                      onClose={() => setShowJumpPopover(false)}
                      onSelect={handleJumpDateSelect}
                      messageDates={messageDates}
                      hasLoadedMessageDates={hasLoadedMessageDates}
                      messageDateCounts={messageDateCounts}
                      loadingDates={loadingDates}
                      loadingDateCounts={loadingDateCounts}
                      style={{ position: 'static', top: 'auto', right: 'auto' }}
                    />
                  </div>,
                  document.body
                )}
                <button
                  className={`icon-btn in-session-search-btn ${showInSessionSearch ? 'active' : ''}`}
                  onClick={handleToggleInSessionSearch}
                  disabled={!currentSessionId}
                  title="搜索会话消息"
                >
                  <Search size={18} />
                </button>
                <button
                  className="icon-btn refresh-messages-btn"
                  onClick={handleRefreshMessages}
                  disabled={isRefreshingMessages || isLoadingMessages}
                  title="刷新消息"
                >
                  <RefreshCw size={18} className={isRefreshingMessages ? 'spin' : ''} />
                </button>
                {!shouldHideStandaloneDetailButton && (
                  <button
                    className={`icon-btn detail-btn ${showDetailPanel ? 'active' : ''}`}
                    onClick={toggleDetailPanel}
                    title="会话详情"
                  >
                    <Info size={18} />
                  </button>
                )}
              </div>
            </div>

            {isPreparingExportDialog && exportPrepareHint && (
              <div className="export-prepare-hint" role="status" aria-live="polite">
                <Loader2 size={14} className="spin" />
                <span>{exportPrepareHint}</span>
              </div>
            )}

            <ContactSnsTimelineDialog
              target={chatSnsTimelineTarget}
              onClose={() => setChatSnsTimelineTarget(null)}
            />

            {/* 会话内搜索浮窗 */}
            {showInSessionSearch && (
              <div className="in-session-search-popup">
                <div className="in-session-search-header">
                  <Search size={16} className="search-icon" />
                  <input
                    ref={inSessionSearchRef}
                    type="text"
                    placeholder="搜索消息..."
                    value={inSessionQuery}
                    onChange={e => handleInSessionSearch(e.target.value)}
                    className="search-input"
                  />
                  {inSessionSearching && <Loader2 size={16} className="spin" />}
                  <button className="close-btn" onClick={handleToggleInSessionSearch}>
                    <X size={16} />
                  </button>
                </div>
                {inSessionQuery && (
                  <div className="search-result-header">
                    {inSessionSearching
                      ? '搜索中...'
                      : inSessionSearchError
                        ? '搜索失败'
                        : `找到 ${inSessionResults.length} 条结果`}
                  </div>
                )}
                {inSessionQuery && !inSessionSearching && inSessionSearchError && (
                  <div className="no-results">
                    <AlertCircle size={32} />
                    <p>{inSessionSearchError}</p>
                  </div>
                )}
                {inSessionResults.length > 0 && (
                  <div className="in-session-results">
                    {inSessionResults.map((msg, i) => {
                      const resolvedSenderDisplayName = resolveSearchSenderDisplayName(
                        msg.senderDisplayName,
                        msg.senderUsername,
                        currentSessionId
                      )
                      const resolvedSenderUsername = resolveSearchSenderUsernameFallback(msg.senderUsername)
                      const resolvedSenderAvatarUrl = normalizeSearchAvatarUrl(msg.senderAvatarUrl)
                      const resolvedCurrentSessionName = normalizeSearchIdentityText(currentSession?.displayName) ||
                        resolveSearchSenderUsernameFallback(currentSession?.username) ||
                        resolveSearchSenderUsernameFallback(currentSessionId)
                      const senderName = resolvedSenderDisplayName || (
                        msg.isSend === 1
                          ? '我'
                          : (isCurrentSessionPrivateSnsSupported
                              ? resolvedCurrentSessionName || (inSessionEnriching ? '加载中...' : '未知')
                              : resolvedSenderUsername || (inSessionEnriching ? '加载中...' : '未知成员'))
                      )
                      const senderAvatar = resolvedSenderAvatarUrl || (
                        msg.isSend === 1
                          ? myAvatarUrl
                          : (isCurrentSessionPrivateSnsSupported ? normalizeSearchAvatarUrl(currentSession?.avatarUrl) : undefined)
                      )
                      const senderAvatarLoading = inSessionEnriching && !senderAvatar
                      const previewText = (msg.parsedContent || msg.content || '').slice(0, 80)
                      const displayTime = msg.createTime
                        ? new Date(msg.createTime * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                        : ''
                      const resultKey = getMessageKey(msg)

                      return (
                        <div key={resultKey} className="result-item" onClick={() => handleInSessionResultJump(msg)}>
                          <div className="result-header">
                            <Avatar src={senderAvatar} name={senderName} size={32} loading={senderAvatarLoading} />
                          </div>
                          <div className="result-content">
                            <span className="result-sender">{senderName}</span>
                            <span className="result-text">{previewText}</span>
                          </div>
                          <span className="result-time">{displayTime}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
                {inSessionQuery && !inSessionSearching && !inSessionSearchError && inSessionResults.length === 0 && (
                  <div className="no-results">
                    <MessageSquare size={32} />
                    <p>未找到相关消息</p>
                  </div>
                )}
              </div>
            )}

            <div className={`message-content-wrapper ${hasInitialMessages ? 'loaded' : 'loading'} ${isSessionSwitching ? 'switching' : ''}`}>
              {standaloneSessionWindow && standaloneLoadStage !== 'ready' && (
                <div className="standalone-phase-overlay" role="status" aria-live="polite">
                  <Loader2 size={22} className="spin" />
                  <span>{standaloneLoadStage === 'connecting' ? '正在建立连接...' : '正在加载最近消息...'}</span>
                  {connectionError && <small>{connectionError}</small>}
                </div>
              )}
              {isLoadingMessages && (!hasInitialMessages || isSessionSwitching) && (
                <div className="loading-messages loading-overlay">
                  <Loader2 size={24} />
                  <span>{isSessionSwitching ? '切换会话中...' : '加载消息中...'}</span>
                </div>
              )}
              <div
                className={`message-list ${hasInitialMessages ? 'loaded' : 'loading'}`}
                ref={handleMessageListScrollParentRef}
                onScroll={markMessageListScrolling}
                onWheel={handleMessageListWheel}
              >
                {!isLoadingMessages && messages.length === 0 && !hasMoreMessages ? (
                  <div className="empty-chat-inline">
                    <MessageSquare size={32} />
                    <span>该联系人没有聊天记录</span>
                  </div>
                ) : (
                  <Virtuoso
                    ref={messageVirtuosoRef}
                    className="message-virtuoso"
                    customScrollParent={messageListScrollParent ?? undefined}
                    data={messages}
                    overscan={220}
                    followOutput={(atBottom) => (
                      prependingHistoryRef.current
                        ? false
                        : (atBottom && isMessageListAtBottomRef.current ? 'auto' : false)
                    )}
                    atBottomThreshold={80}
                    atBottomStateChange={handleMessageAtBottomStateChange}
                    atTopStateChange={handleMessageAtTopStateChange}
                    rangeChanged={handleMessageRangeChanged}
                    computeItemKey={(_, msg) => getMessageKey(msg)}
                    components={messageVirtuosoComponents}
                    itemContent={renderMessageListItem}
                  />
                )}

                {/* 回到底部按钮 */}
                <div className={`scroll-to-bottom ${showScrollToBottom ? 'show' : ''}`} onClick={scrollToBottom}>
                  <ChevronDown size={16} />
                  <span>回到底部</span>
                </div>
              </div>

              {/* 群成员面板 */}
              {showGroupMembersPanel && isCurrentSessionGroup && (
                <div className="detail-panel group-members-panel">
                  <div className="detail-header">
                    <h4>群成员</h4>
                    <button className="close-btn" onClick={() => setShowGroupMembersPanel(false)}>
                      <X size={16} />
                    </button>
                  </div>

                  <div className="group-members-toolbar">
                    <span className="group-members-count">共 {groupPanelMembers.length} 人</span>
                    <div className="group-members-search">
                      <Search size={14} />
                      <input
                        type="text"
                        value={groupMemberSearchKeyword}
                        onChange={(event) => setGroupMemberSearchKeyword(event.target.value)}
                        placeholder="搜索成员"
                      />
                    </div>
                  </div>

                  {isRefreshingGroupMembers && (
                    <div className="group-members-status" role="status" aria-live="polite">
                      <Loader2 size={14} className="spin" />
                      <span>正在统计成员发言数...</span>
                    </div>
                  )}
                  {groupMembersError && groupPanelMembers.length > 0 && (
                    <div className="group-members-status warning" role="status" aria-live="polite">
                      <span>{groupMembersError}</span>
                    </div>
                  )}

                  {isLoadingGroupMembers ? (
                    <div className="detail-loading">
                      <Loader2 size={20} className="spin" />
                      <span>{groupMembersLoadingHint || '加载群成员中...'}</span>
                    </div>
                  ) : groupMembersError && groupPanelMembers.length === 0 ? (
                    <div className="detail-empty">{groupMembersError}</div>
                  ) : filteredGroupPanelMembers.length === 0 ? (
                    <div className="detail-empty">{groupMemberSearchKeyword.trim() ? '暂无匹配成员' : '暂无群成员数据'}</div>
                  ) : (
                    <div className="group-members-list">
                      {filteredGroupPanelMembers.map((member) => (
                        <div key={member.username} className="group-member-item">
                          <div className="group-member-main">
                            <Avatar
                              src={member.avatarUrl}
                              name={member.displayName || member.username}
                              size={34}
                              className="group-member-avatar"
                            />
                            <div className="group-member-meta">
                              <div className="group-member-name-row">
                                <span className="group-member-name" title={member.displayName || member.username}>
                                  {member.displayName || member.username}
                                </span>
                                <div className="group-member-badges">
                                  {member.isOwner && (
                                    <span className="member-flag owner" title="群主">
                                      群主
                                    </span>
                                  )}
                                  {member.isFriend && (
                                    <span className="member-flag friend" title="好友">
                                      好友
                                    </span>
                                  )}
                                </div>
                              </div>
                              <span className="group-member-id" title={member.alias || member.username}>
                                {member.alias || member.username}
                              </span>
                            </div>
                          </div>
                          <span className={`group-member-count ${member.messageCountStatus}`}>
                            {member.messageCountStatus === 'loading'
                              ? '统计中'
                              : member.messageCountStatus === 'failed'
                                ? '统计失败'
                                : `${member.messageCount.toLocaleString()} 条`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 会话详情面板 */}
              {showDetailPanel && (
                <div className="detail-panel session-detail-panel">
                  {isLoadingDetail && !sessionDetail ? (
                    <div className="detail-loading">
                      <Loader2 size={20} className="spin" />
                      <span>加载中...</span>
                    </div>
                  ) : sessionDetail ? (
                    <div className="detail-content">
                      <div className="detail-overview-card">
                        <Avatar
                          src={currentSession?.avatarUrl}
                          name={sessionDetail.remark || sessionDetail.nickName || currentSession?.displayName || sessionDetail.wxid}
                          size={42}
                          className="detail-overview-avatar"
                        />
                        <div className="detail-overview-meta">
                          <span className="detail-overview-name">
                            {sessionDetail.remark || sessionDetail.nickName || currentSession?.displayName || sessionDetail.alias || sessionDetail.wxid}
                          </span>
                          <span className="detail-overview-sub">
                            {sessionDetail.alias || sessionDetail.wxid}
                          </span>
                        </div>
                        <button className="detail-overview-close-btn" onClick={() => setShowDetailPanel(false)} title="关闭详情">
                          <X size={16} />
                        </button>
                      </div>

                      <div className="detail-section detail-basic-section">
                        <div className="detail-item">
                          <Hash size={14} />
                          <span className="label">微信ID</span>
                          <span className="value">{sessionDetail.wxid}</span>
                          <button className="copy-btn" title="复制" onClick={() => handleCopyField(sessionDetail.wxid, 'wxid')}>
                            {copiedField === 'wxid' ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                        </div>
                        {sessionDetail.remark && (
                          <div className="detail-item">
                            <span className="label">备注</span>
                            <span className="value">{sessionDetail.remark}</span>
                            <button className="copy-btn" title="复制" onClick={() => handleCopyField(sessionDetail.remark!, 'remark')}>
                              {copiedField === 'remark' ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        )}
                        {sessionDetail.nickName && (
                          <div className="detail-item">
                            <span className="label">昵称</span>
                            <span className="value">{sessionDetail.nickName}</span>
                            <button className="copy-btn" title="复制" onClick={() => handleCopyField(sessionDetail.nickName!, 'nickName')}>
                              {copiedField === 'nickName' ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        )}
                        {sessionDetail.alias && (
                          <div className="detail-item">
                            <span className="label">微信号</span>
                            <span className="value">{sessionDetail.alias}</span>
                            <button className="copy-btn" title="复制" onClick={() => handleCopyField(sessionDetail.alias!, 'alias')}>
                              {copiedField === 'alias' ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="detail-section detail-stats-section">
                        <div className="section-title">
                          <MessageSquare size={14} />
                          <span>消息统计</span>
                        </div>
                        <div className="detail-stats-meta">
                          {isRefreshingDetailStats
                            ? '统计刷新中...'
                            : sessionDetail.statsUpdatedAt
                              ? `${sessionDetail.statsStale ? '缓存于' : '更新于'} ${formatYmdHmDateTime(sessionDetail.statsUpdatedAt)}${sessionDetail.statsStale ? '（将后台刷新）' : ''}`
                              : (isLoadingDetailExtra ? '统计加载中...' : '暂无统计缓存')}
                        </div>
                        <div className="detail-item">
                          <span className="label">消息总数</span>
                          <span className="value highlight">
                            {Number.isFinite(sessionDetail.messageCount)
                              ? sessionDetail.messageCount.toLocaleString()
                              : ((isLoadingDetail || isLoadingDetailExtra) ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">语音</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.voiceMessages)
                              ? (sessionDetail.voiceMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">图片</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.imageMessages)
                              ? (sessionDetail.imageMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">视频</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.videoMessages)
                              ? (sessionDetail.videoMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">表情包</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.emojiMessages)
                              ? (sessionDetail.emojiMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">转账消息数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.transferMessages)
                              ? (sessionDetail.transferMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">红包消息数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.redPacketMessages)
                              ? (sessionDetail.redPacketMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">通话消息数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.callMessages)
                              ? (sessionDetail.callMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        {sessionDetail.wxid.includes('@chatroom') ? (
                          <>
                            <div className="detail-item">
                              <span className="label">我发的消息数</span>
                              <span className="value">
                                {Number.isFinite(sessionDetail.groupMyMessages)
                                  ? (sessionDetail.groupMyMessages as number).toLocaleString()
                                  : (isLoadingDetailExtra ? '统计中...' : '—')}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="label">群人数</span>
                              <span className="value">
                                {Number.isFinite(sessionDetail.groupMemberCount)
                                  ? (sessionDetail.groupMemberCount as number).toLocaleString()
                                  : (isLoadingDetailExtra ? '统计中...' : '—')}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="label">群发言人数</span>
                              <span className="value">
                                {Number.isFinite(sessionDetail.groupActiveSpeakers)
                                  ? (sessionDetail.groupActiveSpeakers as number).toLocaleString()
                                  : (isLoadingDetailExtra ? '统计中...' : '—')}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="label">群共同好友数</span>
                              <span className="value">
                                {sessionDetail.relationStatsLoaded
                                  ? (Number.isFinite(sessionDetail.groupMutualFriends)
                                    ? (sessionDetail.groupMutualFriends as number).toLocaleString()
                                    : '—')
                                  : (
                                    <button
                                      className="detail-inline-btn"
                                      onClick={() => { void loadRelationStats() }}
                                      disabled={isLoadingRelationStats || isLoadingDetailExtra}
                                    >
                                      {isLoadingRelationStats ? '加载中...' : '点击加载'}
                                    </button>
                                  )}
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="detail-item">
                            <span className="label">共同群聊数</span>
                            <span className="value">
                              {sessionDetail.relationStatsLoaded
                                ? (Number.isFinite(sessionDetail.privateMutualGroups)
                                  ? (sessionDetail.privateMutualGroups as number).toLocaleString()
                                  : '—')
                                : (
                                  <button
                                    className="detail-inline-btn"
                                    onClick={() => { void loadRelationStats() }}
                                    disabled={isLoadingRelationStats || isLoadingDetailExtra}
                                  >
                                    {isLoadingRelationStats ? '加载中...' : '点击加载'}
                                  </button>
                                )}
                            </span>
                          </div>
                        )}
                        <div className="detail-item">
                          <Calendar size={14} />
                          <span className="label">首条消息</span>
                          <span className="value">
                            {sessionDetail.firstMessageTime
                              ? formatYmdDateFromSeconds(sessionDetail.firstMessageTime)
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <Calendar size={14} />
                          <span className="label">最新消息</span>
                          <span className="value">
                            {sessionDetail.latestMessageTime
                              ? formatYmdDateFromSeconds(sessionDetail.latestMessageTime)
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                      </div>

                      <div className="detail-section detail-db-section">
                        <div className="section-title">
                          <Database size={14} />
                          <span>数据库分布</span>
                        </div>
                        {Array.isArray(sessionDetail.messageTables) && sessionDetail.messageTables.length > 0 ? (
                          <div className="table-list">
                            {sessionDetail.messageTables.map((t, i) => (
                              <div key={i} className="table-item">
                                <span className="db-name">{t.dbName}</span>
                                <span className="table-count">{t.count.toLocaleString()} 条</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="detail-table-placeholder">
                            {isLoadingDetailExtra ? '统计中...' : '暂无统计数据'}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="detail-empty">暂无详情</div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty-chat">
            <MessageSquare />
            <p>{standaloneSessionWindow ? '会话加载中或暂无会话记录' : '选择一个会话开始查看聊天记录'}</p>
            {standaloneSessionWindow && connectionError && <p className="hint">{connectionError}</p>}
          </div>
        )}
      </div>

      {/* 语音转文字模型下载弹窗 */}
      {showVoiceTranscribeDialog && (
        <VoiceTranscribeDialog
          onClose={() => {
            setShowVoiceTranscribeDialog(false)
            setPendingVoiceTranscriptRequest(null)
          }}
          onDownloadComplete={async () => {
            setShowVoiceTranscribeDialog(false)
            // 下载完成后，触发页面刷新让组件重新尝试转写
            // 通过更新缓存触发组件重新检查
            if (pendingVoiceTranscriptRequest) {
              // 不直接调用转写，而是让组件自己重试
              // 通过触发一个自定义事件来通知所有 MessageBubble 组件
              window.dispatchEvent(new CustomEvent('model-downloaded', {
                detail: {
                  sessionId: pendingVoiceTranscriptRequest.sessionId,
                  messageId: pendingVoiceTranscriptRequest.messageId
                }
              }))
            }
            setPendingVoiceTranscriptRequest(null)
          }}
        />
      )}

      {/* 批量转写确认对话框 */}
      {showBatchConfirm && createPortal(
        <div className="batch-modal-overlay" onClick={() => setShowBatchConfirm(false)}>
          <div className="batch-modal-content batch-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="batch-modal-header">
              <Mic size={20} />
              <h3>{batchVoiceTaskTitle}</h3>
            </div>
            <div className="batch-modal-body">
              <p>先选择任务类型，再选择日期（仅显示有语音的日期），然后开始处理。</p>
              <div className="batch-task-switch" role="tablist" aria-label="语音批量任务类型">
                <button
                  type="button"
                  className={`batch-task-btn${batchVoiceTaskType === 'decrypt' ? ' active' : ''}`}
                  onClick={() => setBatchVoiceTaskType('decrypt')}
                >
                  批量解密语音
                </button>
                <button
                  type="button"
                  className={`batch-task-btn${batchVoiceTaskType === 'transcribe' ? ' active' : ''}`}
                  onClick={() => setBatchVoiceTaskType('transcribe')}
                >
                  批量转文字
                </button>
              </div>
              {batchVoiceDates.length > 0 && (
                <div className="batch-dates-list-wrap">
                  <div className="batch-dates-actions">
                    <button type="button" className="batch-dates-btn" onClick={selectAllBatchDates}>全选</button>
                    <button type="button" className="batch-dates-btn" onClick={clearAllBatchDates}>取消全选</button>
                  </div>
                  <ul className="batch-dates-list">
                    {batchVoiceDates.map(dateStr => {
                      const count = batchCountByDate.get(dateStr) ?? 0
                      const checked = batchSelectedDates.has(dateStr)
                      return (
                        <li key={dateStr}>
                          <label className="batch-date-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleBatchDate(dateStr)}
                            />
                            <span className="batch-date-label">{formatBatchDateLabel(dateStr)}</span>
                            <span className="batch-date-count">{count} 条语音</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              <div className="batch-info">
                <div className="info-item">
                  <span className="label">已选:</span>
                  <span className="value">{batchSelectedDates.size} 天有语音，共 {batchSelectedMessageCount} 条语音</span>
                </div>
                <div className="info-item">
                  <span className="label">预计耗时:</span>
                  <span className="value">约 {batchVoiceTaskMinutes} 分钟</span>
                </div>
              </div>
              <div className="batch-warning">
                <AlertCircle size={16} />
                <span>
                  {batchVoiceTaskType === 'decrypt'
                    ? '批量解密会预先缓存语音数据，之后播放和转写会更快。解密过程中可以继续使用其他功能。'
                    : '批量转写可能需要较长时间，转写过程中可以继续使用其他功能。已转写过的语音会自动跳过。'}
                </span>
              </div>
            </div>
            <div className="batch-modal-footer">
              <button className="btn-secondary" onClick={() => setShowBatchConfirm(false)}>
                取消
              </button>
              <button className="btn-primary batch-transcribe-start-btn" onClick={confirmBatchTranscribe}>
                <Mic size={16} />
                开始{batchVoiceTaskVerb}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* 消息右键菜单 */}
      {showBatchDecryptConfirm && createPortal(
        <div className="batch-modal-overlay" onClick={() => setShowBatchDecryptConfirm(false)}>
          <div className="batch-modal-content batch-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="batch-modal-header">
              <ImageIcon size={20} />
              <h3>批量解密图片</h3>
            </div>
            <div className="batch-modal-body">
              <p>选择要解密的日期（仅显示有图片的日期），然后开始解密。</p>
              {batchImageDates.length > 0 && (
                <div className="batch-dates-list-wrap">
                  <div className="batch-dates-actions">
                    <button type="button" className="batch-dates-btn" onClick={selectAllBatchImageDates}>全选</button>
                    <button type="button" className="batch-dates-btn" onClick={clearAllBatchImageDates}>取消全选</button>
                  </div>
                  <ul className="batch-dates-list">
                    {batchImageDates.map(dateStr => {
                      const count = batchImageCountByDate.get(dateStr) ?? 0
                      const checked = batchImageSelectedDates.has(dateStr)
                      return (
                        <li key={dateStr}>
                          <label className="batch-date-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleBatchImageDate(dateStr)}
                            />
                            <span className="batch-date-label">{formatBatchDateLabel(dateStr)}</span>
                            <span className="batch-date-count">{count} 张图片</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              <div className="batch-info">
                <div className="info-item">
                  <span className="label">已选:</span>
                  <span className="value">{batchImageSelectedDates.size} 天，共 {batchImageSelectedCount} 张图片</span>
                </div>
                <div className="info-item">
                  <span className="label">并发数:</span>
                  <div className="batch-concurrency-field">
                    <button
                      type="button"
                      className={`batch-concurrency-trigger ${showConcurrencyDropdown ? 'open' : ''}`}
                      onClick={() => setShowConcurrencyDropdown(!showConcurrencyDropdown)}
                    >
                      <span>{batchDecryptConcurrency === 1 ? '1（最慢，最稳）' : batchDecryptConcurrency === 6 ? '6（推荐）' : batchDecryptConcurrency === 20 ? '20（最快，可能卡顿）' : String(batchDecryptConcurrency)}</span>
                      <ChevronDown size={14} />
                    </button>
                    {showConcurrencyDropdown && (
                      <div className="batch-concurrency-dropdown">
                        {[
                          { value: 1, label: '1（最慢，最稳）' },
                          { value: 3, label: '3' },
                          { value: 6, label: '6（推荐）' },
                          { value: 10, label: '10' },
                          { value: 20, label: '20（最快，可能卡顿）' },
                        ].map(opt => (
                          <button
                            key={opt.value}
                            type="button"
                            className={`batch-concurrency-option ${batchDecryptConcurrency === opt.value ? 'active' : ''}`}
                            onClick={() => { setBatchDecryptConcurrency(opt.value); setShowConcurrencyDropdown(false) }}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="batch-warning">
                <AlertCircle size={16} />
                <span>批量解密可能需要较长时间，进行中会在右下角显示非阻塞进度浮层。</span>
              </div>
            </div>
            <div className="batch-modal-footer">
              <button className="btn-secondary" onClick={() => setShowBatchDecryptConfirm(false)}>
                取消
              </button>
              <button className="btn-primary" onClick={confirmBatchDecrypt}>
                <ImageIcon size={16} />
                开始解密
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {contextMenu && createPortal(
        <>
          <div className="context-menu-overlay" onClick={() => setContextMenu(null)}
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 12040 }} />
          <div
            className="context-menu"
            style={{
              position: 'fixed',
              top: contextMenu.y,
              left: contextMenu.x,
              zIndex: 12050,
              maxHeight: 'min(280px, calc(100vh - 24px))',
              overflowY: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="menu-item" onClick={handleEditMessage}>
              <Edit2 size={16} />
              <span>{contextMenu.message.localType === 1 ? '修改消息' : '编辑源码'}</span>
            </div>
            <div className="menu-item" onClick={() => {
              setIsSelectionMode(true)
              setSelectedMessages(new Set<string>([getMessageKey(contextMenu.message)]))
              lastSelectedKeyRef.current = getMessageKey(contextMenu.message)
              setContextMenu(null)
            }}>
              <CheckSquare size={16} />
              <span>多选</span>
            </div>
            <div className="menu-item delete" onClick={(e) => { e.stopPropagation(); handleDelete() }}>
              <Trash2 size={16} />
              <span>删除消息</span>
            </div>
            <div className="menu-item" onClick={() => { setShowMessageInfo(contextMenu.message); setContextMenu(null) }}>
              <Info size={16} />
              <span>查看消息信息</span>
            </div>
          </div>
        </>,
        document.body
      )}

      {/* 消息信息弹窗 */}
      {showMessageInfo && createPortal(
        <div className="message-info-overlay" onClick={() => setShowMessageInfo(null)}>
          <div className="message-info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="detail-header">
              <h4>消息详情</h4>
              <button className="close-btn" onClick={() => setShowMessageInfo(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="detail-content">
              <div className="detail-section">
                <div className="detail-item">
                  <Hash size={14} />
                  <span className="label">Local ID</span>
                  <span className="value">{showMessageInfo.localId}</span>
                  <button className="copy-btn" title="复制" onClick={() => handleCopyField(String(showMessageInfo.localId), 'msgLocalId')}>
                    {copiedField === 'msgLocalId' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
                <div className="detail-item">
                  <Hash size={14} />
                  <span className="label">Server ID</span>
                  <span className="value">{showMessageInfo.serverId}</span>
                </div>
                <div className="detail-item">
                  <span className="label">消息类型</span>
                  <span className="value highlight">{showMessageInfo.localType}</span>
                </div>
                <div className="detail-item">
                  <span className="label">发送者</span>
                  <span className="value">{showMessageInfo.senderUsername || '-'}</span>
                  {showMessageInfo.senderUsername && (
                    <button className="copy-btn" title="复制" onClick={() => handleCopyField(showMessageInfo.senderUsername!, 'msgSender')}>
                      {copiedField === 'msgSender' ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  )}
                </div>
                <div className="detail-item">
                  <Calendar size={14} />
                  <span className="label">创建时间</span>
                  <span className="value">{new Date(showMessageInfo.createTime * 1000).toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <span className="label">发送状态</span>
                  <span className="value">{showMessageInfo.isSend === 1 ? '发送' : '接收'}</span>
                </div>
              </div>

              {(showMessageInfo.imageMd5 || showMessageInfo.videoMd5 || showMessageInfo.voiceDurationSeconds != null) && (
                <div className="detail-section">
                  <div className="section-title">
                    <ImageIcon size={14} />
                    <span>媒体信息</span>
                  </div>
                  {showMessageInfo.imageMd5 && (
                    <div className="detail-item">
                      <span className="label">Image MD5</span>
                      <span className="value mono">{showMessageInfo.imageMd5}</span>
                      <button className="copy-btn" title="复制" onClick={() => handleCopyField(showMessageInfo.imageMd5!, 'imgMd5')}>
                        {copiedField === 'imgMd5' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  )}
                  {showMessageInfo.imageDatName && (
                    <div className="detail-item">
                      <span className="label">DAT 文件</span>
                      <span className="value mono">{showMessageInfo.imageDatName}</span>
                    </div>
                  )}
                  {showMessageInfo.videoMd5 && (
                    <div className="detail-item">
                      <span className="label">Video MD5</span>
                      <span className="value mono">{showMessageInfo.videoMd5}</span>
                      <button className="copy-btn" title="复制" onClick={() => handleCopyField(showMessageInfo.videoMd5!, 'vidMd5')}>
                        {copiedField === 'vidMd5' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  )}
                  {showMessageInfo.voiceDurationSeconds != null && (
                    <div className="detail-item">
                      <Mic size={14} />
                      <span className="label">语音时长</span>
                      <span className="value">{showMessageInfo.voiceDurationSeconds}秒</span>
                    </div>
                  )}
                </div>
              )}

              {(showMessageInfo.emojiMd5 || showMessageInfo.emojiCdnUrl) && (
                <div className="detail-section">
                  <div className="section-title">
                    <span>表情包信息</span>
                  </div>
                  {showMessageInfo.emojiMd5 && (
                    <div className="detail-item">
                      <span className="label">MD5</span>
                      <span className="value mono">{showMessageInfo.emojiMd5}</span>
                    </div>
                  )}
                  {showMessageInfo.emojiCdnUrl && (
                    <div className="detail-item">
                      <span className="label">CDN URL</span>
                      <span className="value mono">{showMessageInfo.emojiCdnUrl}</span>
                    </div>
                  )}
                </div>
              )}

              {showMessageInfo.localType !== 1 && (showMessageInfo.rawContent || showMessageInfo.content) && (
                <div className="detail-section">
                  <div className="section-title">
                    <span>原始消息内容</span>
                    <button className="copy-btn" title="复制" onClick={() => handleCopyField(showMessageInfo.rawContent || showMessageInfo.content || '', 'rawContent')}>
                      {copiedField === 'rawContent' ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                  <div className="raw-content-box">
                    <pre>{showMessageInfo.rawContent || showMessageInfo.content}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 修改消息弹窗 */}
      {editingMessage && createPortal(
        <div className="modal-overlay">
          <div className="modal-content edit-message-modal">
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>{editingMessage.message.localType === 1 ? '修改消息' : '编辑消息'}</h3>
              <button className="close-btn" onClick={() => setEditingMessage(null)}>
                <X size={16} />
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              {editMode === 'raw' ? (
                <textarea
                  className="edit-message-textarea"
                  style={{ fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
                  value={editingMessage.content}
                  onChange={(e) => setEditingMessage({ ...editingMessage, content: e.target.value })}
                  rows={editingMessage.message.localType === 1 ? 8 : 15}
                />
              ) : (
                <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {tempFields.map((field, idx) => (
                    <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                          {field.tagName ? field.tagName : '节点'}: <span style={{ color: 'var(--primary)' }}>{field.key}</span>
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', opacity: 0.6 }}>
                          {field.type === 'attr' ? '属性' : '文本内容'}
                        </span>
                      </div>
                      <input
                        type="text"
                        value={field.value}
                        onChange={(e) => {
                          const newFields = [...tempFields]
                          newFields[idx].value = e.target.value
                          setTempFields(newFields)
                        }}
                        style={{
                          background: 'var(--bg-tertiary)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '6px',
                          padding: '10px 12px',
                          color: 'var(--text-primary)',
                          fontSize: '13px',
                          outline: 'none',
                          width: '100%',
                          boxSizing: 'border-box'
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <div>
                {editingMessage.message.localType !== 1 && tempFields.length > 0 && (
                  <button
                    onClick={() => setEditMode(editMode === 'raw' ? 'fields' : 'raw')}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-color)',
                      background: editMode === 'fields' ? 'var(--primary)' : 'transparent',
                      color: editMode === 'fields' ? '#fff' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                  >
                    {editMode === 'raw' ? '可视化编辑' : '源码编辑'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="btn-secondary" onClick={() => setEditingMessage(null)}>取消</button>
                <button className="btn-primary" onClick={handleSaveEdit}>保存</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 底部多选操作栏 */}
      {isSelectionMode && (
        <div style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'var(--bg-secondary)', // Use system background
          color: 'var(--text-primary)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          borderRadius: '12px',
          padding: '12px 24px',
          display: 'flex',
          gap: '20px',
          zIndex: 1000,
          alignItems: 'center',
          border: '1px solid var(--border-color)', // Subtle border
          backdropFilter: 'blur(10px)'
        }}>
          <span style={{ fontSize: '14px', fontWeight: 500 }}>已选 {selectedMessages.size} 条</span>
          <div style={{ width: '1px', height: '16px', background: 'var(--border-color)' }}></div>
          <button
            className="btn-danger"
            onClick={handleBatchDelete}
            style={{
              padding: '6px 16px',
              borderRadius: '6px',
              border: 'none',
              backgroundColor: '#fa5151',
              color: 'white',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500
            }}
          >
            删除
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              setIsSelectionMode(false)
              setSelectedMessages(new Set<string>())
              lastSelectedKeyRef.current = null
            }}
            style={{
              padding: '6px 16px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              backgroundColor: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            取消
          </button>
        </div>
      )}
    </div>
  )
}

// 全局语音播放管理器：同一时间只能播放一条语音
const globalVoiceManager = {
  currentAudio: null as HTMLAudioElement | null,
  currentStopCallback: null as (() => void) | null,
  play(audio: HTMLAudioElement, onStop: () => void) {
    // 停止当前正在播放的语音
    if (this.currentAudio && this.currentAudio !== audio) {
      this.currentAudio.pause()
      this.currentAudio.currentTime = 0
      this.currentStopCallback?.()
    }
    this.currentAudio = audio
    this.currentStopCallback = onStop
  },
  stop(audio: HTMLAudioElement) {
    if (this.currentAudio === audio) {
      this.currentAudio = null
      this.currentStopCallback = null
    }
  },
}

// 前端表情包缓存
const emojiDataUrlCache = new Map<string, string>()
const imageDataUrlCache = new Map<string, string>()
const voiceDataUrlCache = new Map<string, string>()
const voiceTranscriptCache = new Map<string, string>()
type SharedImageDecryptResult = { success: boolean; localPath?: string; liveVideoPath?: string; error?: string }
const imageDecryptInFlight = new Map<string, Promise<SharedImageDecryptResult>>()
const senderAvatarCache = new Map<string, { avatarUrl?: string; displayName?: string }>()
const senderAvatarLoading = new Map<string, Promise<{ avatarUrl?: string; displayName?: string } | null>>()

function getSharedImageDecryptTask(
  key: string,
  createTask: () => Promise<SharedImageDecryptResult>
): Promise<SharedImageDecryptResult> {
  const existing = imageDecryptInFlight.get(key)
  if (existing) return existing
  const task = createTask().finally(() => {
    if (imageDecryptInFlight.get(key) === task) {
      imageDecryptInFlight.delete(key)
    }
  })
  imageDecryptInFlight.set(key, task)
  return task
}

const buildVoiceCacheIdentity = (
  sessionId: string,
  message: Pick<Message, 'localId' | 'createTime' | 'serverId' | 'serverIdRaw'>
): string => {
  const normalizedSessionId = String(sessionId || '').trim()
  const localId = Math.max(0, Math.floor(Number(message?.localId || 0)))
  const createTime = Math.max(0, Math.floor(Number(message?.createTime || 0)))
  const serverIdRaw = String(message?.serverIdRaw ?? message?.serverId ?? '').trim()
  const serverId = /^\d+$/.test(serverIdRaw)
    ? serverIdRaw.replace(/^0+(?=\d)/, '')
    : String(Math.max(0, Math.floor(Number(serverIdRaw || 0))))
  return `${normalizedSessionId}:${localId}:${createTime}:${serverId || '0'}`
}

// 引用消息中的动画表情组件
function QuotedEmoji({ cdnUrl, md5 }: { cdnUrl: string; md5?: string }) {
  const cacheKey = md5 || cdnUrl
  const [localPath, setLocalPath] = useState<string | undefined>(() => emojiDataUrlCache.get(cacheKey))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (localPath || loading || error) return
    setLoading(true)
    window.electronAPI.chat.downloadEmoji(cdnUrl, md5).then((result: { success: boolean; localPath?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        setLocalPath(result.localPath)
      } else {
        setError(true)
      }
    }).catch(() => setError(true)).finally(() => setLoading(false))
  }, [cdnUrl, md5, cacheKey, localPath, loading, error])

  if (error || (!loading && !localPath)) return <span className="quoted-type-label">[动画表情]</span>
  if (loading) return <span className="quoted-type-label">[动画表情]</span>
  return <img src={localPath} alt="动画表情" className="quoted-emoji-image" />
}

// 消息气泡组件
function MessageBubble({
  message,
  messageKey,
  session,
  showTime,
  myAvatarUrl,
  myWxid,
  isGroupChat,
  autoTranscribeVoiceEnabled,
  onRequireModelDownload,
  onContextMenu,
  isSelectionMode,
  isSelected,
  onToggleSelection
}: {
  message: Message;
  messageKey: string;
  session: ChatSession;
  showTime?: boolean;
  myAvatarUrl?: string;
  myWxid?: string;
  isGroupChat?: boolean;
  autoTranscribeVoiceEnabled?: boolean;
  onRequireModelDownload?: (sessionId: string, messageId: string) => void;
  onContextMenu?: (e: React.MouseEvent, message: Message) => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelection?: (messageKey: string, isShiftKey?: boolean) => void;
}) {
  const isSystem = isSystemMessage(message.localType)
  const isEmoji = message.localType === 47
  const isImage = message.localType === 3
  const isVideo = message.localType === 43
  const isVoice = message.localType === 34
  const isCard = message.localType === 42
  const isCall = message.localType === 50
  const isType49 = message.localType === 49
  const isSent = message.isSend === 1
  const [senderAvatarUrl, setSenderAvatarUrl] = useState<string | undefined>(undefined)
  const [senderName, setSenderName] = useState<string | undefined>(undefined)
  const [quotedSenderName, setQuotedSenderName] = useState<string | undefined>(undefined)
  const [quoteLayout, setQuoteLayout] = useState<QuoteLayout>('quote-top')
  const senderProfileRequestSeqRef = useRef(0)
  const [emojiError, setEmojiError] = useState(false)
  const [emojiLoading, setEmojiLoading] = useState(false)

  // 缓存相关的 state 必须在所有 Hooks 之前声明
  const cacheKey = message.emojiMd5 || message.emojiCdnUrl || ''
  const [emojiLocalPath, setEmojiLocalPath] = useState<string | undefined>(
    () => emojiDataUrlCache.get(cacheKey) || message.emojiLocalPath
  )
  const imageCacheKey = message.imageMd5 || message.imageDatName || `local:${message.localId}`
  const [imageLocalPath, setImageLocalPath] = useState<string | undefined>(
    () => imageDataUrlCache.get(imageCacheKey)
  )
  const voiceIdentityKey = buildVoiceCacheIdentity(session.username, message)
  const voiceCacheKey = `voice:${voiceIdentityKey}`
  const [voiceDataUrl, setVoiceDataUrl] = useState<string | undefined>(
    () => voiceDataUrlCache.get(voiceCacheKey)
  )
  const voiceTranscriptCacheKey = `voice-transcript:${voiceIdentityKey}`
  const [voiceTranscript, setVoiceTranscript] = useState<string | undefined>(
    () => voiceTranscriptCache.get(voiceTranscriptCacheKey)
  )

  // State variables...
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageStageLockHeight, setImageStageLockHeight] = useState<number | null>(null)
  const [imageHasUpdate, setImageHasUpdate] = useState(false)
  const [imageClicked, setImageClicked] = useState(false)
  const imageUpdateCheckedRef = useRef<string | null>(null)
  const imageClickTimerRef = useRef<number | null>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const emojiContainerRef = useRef<HTMLDivElement>(null)
  const imageResizeBaselineRef = useRef<number | null>(null)
  const emojiResizeBaselineRef = useRef<number | null>(null)
  const imageObservedHeightRef = useRef<number | null>(null)
  const emojiObservedHeightRef = useRef<number | null>(null)
  const imageAutoDecryptTriggered = useRef(false)
  const imageAutoHdTriggered = useRef<string | null>(null)
  const [imageInView, setImageInView] = useState(false)
  const imageForceHdAttempted = useRef<string | null>(null)
  const imageForceHdPending = useRef(false)
  const imageDecryptPendingRef = useRef(false)
  const [imageLiveVideoPath, setImageLiveVideoPath] = useState<string | undefined>(undefined)
  const [voiceError, setVoiceError] = useState(false)
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [isVoicePlaying, setIsVoicePlaying] = useState(false)
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const [voiceTranscriptLoading, setVoiceTranscriptLoading] = useState(false)
  const [voiceTranscriptError, setVoiceTranscriptError] = useState(false)
  const voiceTranscriptRequestedRef = useRef(false)
  const [voiceCurrentTime, setVoiceCurrentTime] = useState(0)
  const [voiceDuration, setVoiceDuration] = useState(0)
  const [voiceWaveform, setVoiceWaveform] = useState<number[]>([])
  const voiceAutoDecryptTriggered = useRef(false)


  const [systemAlert, setSystemAlert] = useState<{
    title: string;
    message: React.ReactNode;
  } | null>(null)

  // 转账消息双方名称
  const [transferPayerName, setTransferPayerName] = useState<string | undefined>(undefined)
  const [transferReceiverName, setTransferReceiverName] = useState<string | undefined>(undefined)

  // 视频相关状态
  const [videoLoading, setVideoLoading] = useState(false)
  const [videoInfo, setVideoInfo] = useState<{ videoUrl?: string; coverUrl?: string; thumbUrl?: string; exists: boolean } | null>(null)
  const videoContainerRef = useRef<HTMLElement>(null)
  const [isVideoVisible, setIsVideoVisible] = useState(false)
  const [videoMd5, setVideoMd5] = useState<string | null>(null)
  const imageStageLockStyle = useMemo<React.CSSProperties | undefined>(() => (
    imageStageLockHeight && imageStageLockHeight > 0
      ? { height: `${Math.round(imageStageLockHeight)}px` }
      : undefined
  ), [imageStageLockHeight])

  // 解析视频 MD5
  useEffect(() => {
    if (!isVideo) return





    // 优先使用数据库中的 videoMd5
    if (message.videoMd5) {

      setVideoMd5(message.videoMd5)
      return
    }

    // 尝试从多个可能的字段获取原始内容
    const contentToUse = message.content || (message as any).rawContent || message.parsedContent
    if (contentToUse) {

      window.electronAPI.video.parseVideoMd5(contentToUse).then((result: { success: boolean; md5?: string; error?: string }) => {

        if (result && result.success && result.md5) {

          setVideoMd5(result.md5)
        } else {
          console.error('[Video Debug] Failed to parse MD5:', result)
        }
      }).catch((err: unknown) => {
        console.error('[Video Debug] Parse error:', err)
      })
    }
  }, [isVideo, message.videoMd5, message.content, message.parsedContent])

  const formatTime = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '未知时间'
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }) + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const detectImageMimeFromBase64 = useCallback((base64: string): string => {
    try {
      const head = window.atob(base64.slice(0, 48))
      const bytes = new Uint8Array(head.length)
      for (let i = 0; i < head.length; i++) {
        bytes[i] = head.charCodeAt(i)
      }
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp'
      }
    } catch { }
    return 'image/jpeg'
  }, [])

  const getImageObserverRoot = useCallback((): Element | null => {
    return imageContainerRef.current?.closest('.message-list') ?? null
  }, [])

  const stabilizeScrollerByDelta = useCallback((host: HTMLElement | null, delta: number) => {
    if (!host) return
    if (!Number.isFinite(delta) || Math.abs(delta) < 1) return
    const scroller = host.closest('.message-list') as HTMLDivElement | null
    if (!scroller) return

    const distanceFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight)
    if (distanceFromBottom <= 96) return

    const scrollerRect = scroller.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const hostTopInScroller = hostRect.top - scrollerRect.top + scroller.scrollTop
    const viewportBottom = scroller.scrollTop + scroller.clientHeight
    if (hostTopInScroller > viewportBottom + 24) return

    scroller.scrollTop += delta
  }, [])

  const bindResizeObserverForHost = useCallback((
    host: HTMLElement | null,
    observedHeightRef: React.MutableRefObject<number | null>,
    pendingBaselineRef: React.MutableRefObject<number | null>
  ) => {
    if (!host) return

    const initialHeight = host.getBoundingClientRect().height
    observedHeightRef.current = Number.isFinite(initialHeight) && initialHeight > 0 ? initialHeight : null
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      const nextHeight = host.getBoundingClientRect().height
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
        observedHeightRef.current = null
        return
      }
      const previousHeight = observedHeightRef.current
      observedHeightRef.current = nextHeight
      if (!Number.isFinite(previousHeight) || (previousHeight as number) <= 0) return
      if (pendingBaselineRef.current !== null) return
      stabilizeScrollerByDelta(host, nextHeight - (previousHeight as number))
    })

    observer.observe(host)
    return () => {
      observer.disconnect()
    }
  }, [stabilizeScrollerByDelta])

  const captureResizeBaseline = useCallback(
    (host: HTMLElement | null, baselineRef: React.MutableRefObject<number | null>) => {
      if (!host) return
      const height = host.getBoundingClientRect().height
      if (!Number.isFinite(height) || height <= 0) return
      baselineRef.current = height
    },
    []
  )

  const stabilizeScrollAfterResize = useCallback(
    (host: HTMLElement | null, baselineRef: React.MutableRefObject<number | null>) => {
      if (!host) return
      const baseline = baselineRef.current
      baselineRef.current = null
      if (!Number.isFinite(baseline) || (baseline as number) <= 0) return

      requestAnimationFrame(() => {
        const nextHeight = host.getBoundingClientRect().height
        stabilizeScrollerByDelta(host, nextHeight - (baseline as number))
      })
    },
    [stabilizeScrollerByDelta]
  )

  const captureImageResizeBaseline = useCallback(() => {
    captureResizeBaseline(imageContainerRef.current, imageResizeBaselineRef)
  }, [captureResizeBaseline])

  const lockImageStageHeight = useCallback(() => {
    const host = imageContainerRef.current
    if (!host) return
    const height = host.getBoundingClientRect().height
    if (!Number.isFinite(height) || height <= 0) return
    setImageStageLockHeight(Math.round(height))
  }, [])

  const captureEmojiResizeBaseline = useCallback(() => {
    captureResizeBaseline(emojiContainerRef.current, emojiResizeBaselineRef)
  }, [captureResizeBaseline])

  const stabilizeImageScrollAfterResize = useCallback(() => {
    stabilizeScrollAfterResize(imageContainerRef.current, imageResizeBaselineRef)
  }, [stabilizeScrollAfterResize])

  const releaseImageStageLock = useCallback(() => {
    window.requestAnimationFrame(() => {
      setImageStageLockHeight(null)
    })
  }, [])

  const stabilizeEmojiScrollAfterResize = useCallback(() => {
    stabilizeScrollAfterResize(emojiContainerRef.current, emojiResizeBaselineRef)
  }, [stabilizeScrollAfterResize])

  useEffect(() => {
    if (!isImage) return
    return bindResizeObserverForHost(imageContainerRef.current, imageObservedHeightRef, imageResizeBaselineRef)
  }, [isImage, imageLocalPath, imageLoading, imageError, bindResizeObserverForHost])

  useEffect(() => {
    if (!isEmoji) return
    return bindResizeObserverForHost(emojiContainerRef.current, emojiObservedHeightRef, emojiResizeBaselineRef)
  }, [isEmoji, emojiLocalPath, emojiLoading, emojiError, bindResizeObserverForHost])

  // 下载表情包
  const downloadEmoji = () => {
    if (!message.emojiCdnUrl || emojiLoading) return

    // 先检查缓存
    const cached = emojiDataUrlCache.get(cacheKey)
    if (cached) {
      captureEmojiResizeBaseline()
      setEmojiLocalPath(cached)
      setEmojiError(false)
      return
    }

    setEmojiLoading(true)
    setEmojiError(false)
    window.electronAPI.chat.downloadEmoji(message.emojiCdnUrl, message.emojiMd5).then((result: { success: boolean; localPath?: string; error?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        captureEmojiResizeBaseline()
        setEmojiLocalPath(result.localPath)
      } else {
        setEmojiError(true)
      }
    }).catch(() => {
      setEmojiError(true)
    }).finally(() => {
      setEmojiLoading(false)
    })
  }

  // 群聊中获取发送者信息 (如果自己发的没头像，也尝试拉取)
  useEffect(() => {
    const sender = String(message.senderUsername || '').trim()
    const cached = sender ? senderAvatarCache.get(sender) : undefined
    setSenderAvatarUrl(cached?.avatarUrl || message.senderAvatarUrl || undefined)
    setSenderName(cached?.displayName || message.senderDisplayName || undefined)

    if (!sender || !(isGroupChat || (isSent && !myAvatarUrl))) return

    const requestSeq = senderProfileRequestSeqRef.current + 1
    senderProfileRequestSeqRef.current = requestSeq
    let cancelled = false
    const applyProfile = (result: { avatarUrl?: string; displayName?: string } | null) => {
      if (!result || cancelled) return
      if (requestSeq !== senderProfileRequestSeqRef.current) return
      if (result.avatarUrl) setSenderAvatarUrl(result.avatarUrl)
      if (result.displayName) setSenderName(result.displayName)
    }

    if (cached) {
      applyProfile(cached)
      return () => {
        cancelled = true
      }
    }

    const pending = senderAvatarLoading.get(sender)
    if (pending) {
      pending.then(applyProfile).catch(() => { })
      return () => {
        cancelled = true
      }
    }

    const request = window.electronAPI.chat.getContactAvatar(sender)
    senderAvatarLoading.set(sender, request)
    request.then((result: { avatarUrl?: string; displayName?: string } | null) => {
      if (result) {
        senderAvatarCache.set(sender, result)
      }
      applyProfile(result)
    }).catch(() => { }).finally(() => {
      if (senderAvatarLoading.get(sender) === request) {
        senderAvatarLoading.delete(sender)
      }
    })

    return () => {
      cancelled = true
    }
  }, [isGroupChat, isSent, message.senderAvatarUrl, message.senderDisplayName, message.senderUsername, myAvatarUrl])

  // 解析转账消息的付款方和收款方显示名称
  useEffect(() => {
    const payerWxid = (message as any).transferPayerUsername
    const receiverWxid = (message as any).transferReceiverUsername
    if (!payerWxid && !receiverWxid) return
    // 仅对转账消息类型处理
    if (message.localType !== 49 && message.localType !== 8589934592049) return

    window.electronAPI.chat.resolveTransferDisplayNames(
      session.username,
      payerWxid || '',
      receiverWxid || ''
    ).then((result: { payerName: string; receiverName: string }) => {
      if (result) {
        setTransferPayerName(result.payerName)
        setTransferReceiverName(result.receiverName)
      }
    }).catch(() => { })
  }, [(message as any).transferPayerUsername, (message as any).transferReceiverUsername, session.username])

  // 自动下载表情包
  useEffect(() => {
    if (emojiLocalPath) return
    // 后端已从本地缓存找到文件（转发表情包无 CDN URL 的情况）
    if (isEmoji && message.emojiLocalPath) {
      captureEmojiResizeBaseline()
      setEmojiLocalPath(message.emojiLocalPath)
      return
    }
    if (isEmoji && message.emojiCdnUrl && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, message.emojiCdnUrl, message.emojiLocalPath, emojiLocalPath, emojiLoading, emojiError, captureEmojiResizeBaseline])

  const requestImageDecrypt = useCallback(async (forceUpdate = false, silent = false): Promise<SharedImageDecryptResult> => {
    if (!isImage) return { success: false }
    if (imageDecryptPendingRef.current) return { success: false }
    imageDecryptPendingRef.current = true
    if (!silent) {
      setImageLoading(true)
      setImageError(false)
    }
    try {
      if (message.imageMd5 || message.imageDatName) {
        const sharedDecryptKey = `${session.username}:${imageCacheKey}:${forceUpdate ? 'force' : 'normal'}`
        const result = await getSharedImageDecryptTask(sharedDecryptKey, async () => {
          return await window.electronAPI.image.decrypt({
            sessionId: session.username,
            imageMd5: message.imageMd5 || undefined,
            imageDatName: message.imageDatName,
            force: forceUpdate
          }) as SharedImageDecryptResult
        })
        if (result.success && result.localPath) {
          imageDataUrlCache.set(imageCacheKey, result.localPath)
          if (imageLocalPath !== result.localPath) {
            captureImageResizeBaseline()
            lockImageStageHeight()
          }
          setImageLocalPath(result.localPath)
          setImageHasUpdate(false)
          if (result.liveVideoPath) setImageLiveVideoPath(result.liveVideoPath)
          return result
        }
      }

      const fallback = await window.electronAPI.chat.getImageData(session.username, String(message.localId))
      if (fallback.success && fallback.data) {
        const mime = detectImageMimeFromBase64(fallback.data)
        const dataUrl = `data:${mime};base64,${fallback.data}`
        imageDataUrlCache.set(imageCacheKey, dataUrl)
        if (imageLocalPath !== dataUrl) {
          captureImageResizeBaseline()
          lockImageStageHeight()
        }
        setImageLocalPath(dataUrl)
        setImageHasUpdate(false)
        return { success: true, localPath: dataUrl }
      }
      if (!silent) setImageError(true)
    } catch {
      if (!silent) setImageError(true)
    } finally {
      if (!silent) setImageLoading(false)
      imageDecryptPendingRef.current = false
    }
    return { success: false }
  }, [isImage, message.imageMd5, message.imageDatName, message.localId, session.username, imageCacheKey, detectImageMimeFromBase64, imageLocalPath, captureImageResizeBaseline, lockImageStageHeight])

  const triggerForceHd = useCallback(() => {
    if (!message.imageMd5 && !message.imageDatName) return
    if (imageForceHdAttempted.current === imageCacheKey) return
    if (imageForceHdPending.current) return
    imageForceHdAttempted.current = imageCacheKey
    imageForceHdPending.current = true
    requestImageDecrypt(true, true).finally(() => {
      imageForceHdPending.current = false
    })
  }, [imageCacheKey, message.imageDatName, message.imageMd5, requestImageDecrypt])

  const handleImageClick = useCallback(() => {
    if (imageClickTimerRef.current) {
      window.clearTimeout(imageClickTimerRef.current)
    }
    setImageClicked(true)
    imageClickTimerRef.current = window.setTimeout(() => {
      setImageClicked(false)
    }, 800)
    console.info('[UI] image decrypt click (force HD)', {
      sessionId: session.username,
      imageMd5: message.imageMd5,
      imageDatName: message.imageDatName,
      localId: message.localId
    })
    void requestImageDecrypt(true)
  }, [message.imageDatName, message.imageMd5, message.localId, requestImageDecrypt, session.username])

  const handleOpenImageViewer = useCallback(async () => {
    if (!imageLocalPath) return

    let finalImagePath = imageLocalPath
    let finalLiveVideoPath = imageLiveVideoPath || undefined

    // Every explicit preview click re-runs the forced HD search/decrypt path so
    // users don't need to re-enter the session after WeChat materializes a new original image.
    if (message.imageMd5 || message.imageDatName) {
      try {
        const upgraded = await requestImageDecrypt(true, true)
        if (upgraded?.success && upgraded.localPath) {
          finalImagePath = upgraded.localPath
          finalLiveVideoPath = upgraded.liveVideoPath || finalLiveVideoPath
        }
      } catch { }
    }

    // One more resolve helps when background/batch decrypt has produced a clearer image or live video
    // but local component state hasn't caught up yet.
    if (message.imageMd5 || message.imageDatName) {
      try {
        const resolved = await window.electronAPI.image.resolveCache({
          sessionId: session.username,
          imageMd5: message.imageMd5 || undefined,
          imageDatName: message.imageDatName
        })
        if (resolved?.success && resolved.localPath) {
          finalImagePath = resolved.localPath
          finalLiveVideoPath = resolved.liveVideoPath || finalLiveVideoPath
          imageDataUrlCache.set(imageCacheKey, resolved.localPath)
          if (imageLocalPath !== resolved.localPath) {
            captureImageResizeBaseline()
            lockImageStageHeight()
          }
          setImageLocalPath(resolved.localPath)
          if (resolved.liveVideoPath) setImageLiveVideoPath(resolved.liveVideoPath)
          setImageHasUpdate(Boolean(resolved.hasUpdate))
        }
      } catch { }
    }

    void window.electronAPI.window.openImageViewerWindow(finalImagePath, finalLiveVideoPath)
  }, [
    imageLiveVideoPath,
    imageLocalPath,
    imageCacheKey,
    captureImageResizeBaseline,
    lockImageStageHeight,
    message.imageDatName,
    message.imageMd5,
    requestImageDecrypt,
    session.username
  ])

  useEffect(() => {
    return () => {
      if (imageClickTimerRef.current) {
        window.clearTimeout(imageClickTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    setImageLoaded(false)
  }, [imageLocalPath])

  useEffect(() => {
    if (imageLoading) return
    if (!imageError && imageLocalPath) return
    setImageStageLockHeight(null)
  }, [imageError, imageLoading, imageLocalPath])

  useEffect(() => {
    if (!isImage || imageLoading) return
    if (!message.imageMd5 && !message.imageDatName) return
    if (imageUpdateCheckedRef.current === imageCacheKey) return
    imageUpdateCheckedRef.current = imageCacheKey
    let cancelled = false
    window.electronAPI.image.resolveCache({
      sessionId: session.username,
      imageMd5: message.imageMd5 || undefined,
      imageDatName: message.imageDatName
    }).then((result: { success: boolean; localPath?: string; hasUpdate?: boolean; liveVideoPath?: string; error?: string }) => {
      if (cancelled) return
      if (result.success && result.localPath) {
        imageDataUrlCache.set(imageCacheKey, result.localPath)
        if (!imageLocalPath || imageLocalPath !== result.localPath) {
          captureImageResizeBaseline()
          lockImageStageHeight()
          setImageLocalPath(result.localPath)
          setImageError(false)
        }
        if (result.liveVideoPath) setImageLiveVideoPath(result.liveVideoPath)
        setImageHasUpdate(Boolean(result.hasUpdate))
      }
    }).catch(() => { })
    return () => {
      cancelled = true
    }
  }, [isImage, imageLocalPath, imageLoading, message.imageMd5, message.imageDatName, imageCacheKey, session.username, captureImageResizeBaseline, lockImageStageHeight])

  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onUpdateAvailable((payload: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        setImageHasUpdate(true)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, message.imageDatName, message.imageMd5])

  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onCacheResolved((payload: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        const cachedPath = imageDataUrlCache.get(imageCacheKey)
        if (cachedPath !== payload.localPath) {
          imageDataUrlCache.set(imageCacheKey, payload.localPath)
        }
        if (imageLocalPath !== payload.localPath) {
          captureImageResizeBaseline()
          lockImageStageHeight()
        }
        setImageLocalPath((prev) => (prev === payload.localPath ? prev : payload.localPath))
        setImageError(false)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, imageCacheKey, imageLocalPath, message.imageDatName, message.imageMd5, captureImageResizeBaseline, lockImageStageHeight])

  // 图片进入视野前自动解密（懒加载）
  useEffect(() => {
    if (!isImage) return
    if (imageLocalPath) return // 已有图片，不需要解密
    if (!message.imageMd5 && !message.imageDatName) return

    const container = imageContainerRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        // rootMargin 设置为 200px，提前感知即将进入视野的图片
        setImageInView(entry.isIntersecting)
      },
      { root: getImageObserverRoot(), rootMargin: '200px', threshold: 0 }
    )

    observer.observe(container)
    return () => observer.disconnect()
  }, [getImageObserverRoot, isImage])

  // 进入视野后自动触发一次普通解密
  useEffect(() => {
    if (!isImage || !imageInView) return
    if (imageLocalPath || imageLoading) return
    if (!message.imageMd5 && !message.imageDatName) return
    if (imageAutoDecryptTriggered.current) return
    imageAutoDecryptTriggered.current = true
    void requestImageDecrypt()
  }, [isImage, imageInView, imageLocalPath, imageLoading, message.imageMd5, message.imageDatName, requestImageDecrypt])

  useEffect(() => {
    if (!isImage || !imageHasUpdate || !imageInView) return
    if (imageAutoHdTriggered.current === imageCacheKey) return
    imageAutoHdTriggered.current = imageCacheKey
    triggerForceHd()
  }, [isImage, imageHasUpdate, imageInView, imageCacheKey, triggerForceHd])


  useEffect(() => {
    if (!isVoice) return
    if (!voiceAudioRef.current) {
      voiceAudioRef.current = new Audio()
    }
    const audio = voiceAudioRef.current
    if (!audio) return
    const handlePlay = () => setIsVoicePlaying(true)
    const handlePause = () => setIsVoicePlaying(false)
    const handleEnded = () => {
      setIsVoicePlaying(false)
      setVoiceCurrentTime(0)
      globalVoiceManager.stop(audio)
    }
    const handleTimeUpdate = () => {
      setVoiceCurrentTime(audio.currentTime)
    }
    const handleLoadedMetadata = () => {
      setVoiceDuration(audio.duration)
    }
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    return () => {
      audio.pause()
      globalVoiceManager.stop(audio)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
    }
  }, [isVoice])

  // 生成波形数据
  useEffect(() => {
    if (!voiceDataUrl) {
      setVoiceWaveform([])
      return
    }

    const generateWaveform = async () => {
      try {
        // 从 data:audio/wav;base64,... 提取 base64
        const base64 = voiceDataUrl.split(',')[1]
        const binaryString = window.atob(base64)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }

        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer)
        const rawData = audioBuffer.getChannelData(0) // 获取单声道数据
        const samples = 35 // 波形柱子数量
        const blockSize = Math.floor(rawData.length / samples)
        const filteredData: number[] = []

        for (let i = 0; i < samples; i++) {
          let blockStart = blockSize * i
          let sum = 0
          for (let j = 0; j < blockSize; j++) {
            sum = sum + Math.abs(rawData[blockStart + j])
          }
          filteredData.push(sum / blockSize)
        }

        // 归一化
        const multiplier = Math.pow(Math.max(...filteredData), -1)
        const normalizedData = filteredData.map(n => n * multiplier)
        setVoiceWaveform(normalizedData)
        void audioCtx.close()
      } catch (e) {
        console.error('Failed to generate waveform:', e)
        // 降级：生成随机但平滑的波形
        setVoiceWaveform(Array.from({ length: 35 }, () => 0.2 + Math.random() * 0.8))
      }
    }

    void generateWaveform()
  }, [voiceDataUrl])

  // 消息加载时自动检测语音缓存
  useEffect(() => {
    if (!isVoice || voiceDataUrl) return
    window.electronAPI.chat.resolveVoiceCache(session.username, String(message.localId))
      .then((result: { success: boolean; hasCache: boolean; data?: string; error?: string }) => {
        if (result.success && result.hasCache && result.data) {
          const url = `data:audio/wav;base64,${result.data}`
          voiceDataUrlCache.set(voiceCacheKey, url)
          setVoiceDataUrl(url)
        }
      })
  }, [isVoice, message.localId, session.username, voiceCacheKey, voiceDataUrl])

  // 监听流式转写结果
  useEffect(() => {
    if (!isVoice) return
    const removeListener = window.electronAPI.chat.onVoiceTranscriptPartial?.((payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => {
      const sameSession = !payload.sessionId || payload.sessionId === session.username
      const sameMsgId = payload.msgId === String(message.localId)
      const sameCreateTime = payload.createTime == null || Number(payload.createTime) === Number(message.createTime || 0)
      if (!sameSession || !sameMsgId || !sameCreateTime) return
      setVoiceTranscript(payload.text)
      voiceTranscriptCache.set(voiceTranscriptCacheKey, payload.text)
    })
    return () => removeListener?.()
  }, [isVoice, message.createTime, message.localId, session.username, voiceTranscriptCacheKey])

  const requestVoiceTranscript = useCallback(async () => {
    if (voiceTranscriptLoading || voiceTranscriptRequestedRef.current) return

    // 检查 whisper API 是否可用
    if (!window.electronAPI?.whisper?.getModelStatus) {
      console.warn('[ChatPage] whisper API 不可用')
      setVoiceTranscriptError(true)
      return
    }

    voiceTranscriptRequestedRef.current = true
    setVoiceTranscriptLoading(true)
    setVoiceTranscriptError(false)
    try {
      // 检查模型状态
      const modelStatus = await window.electronAPI.whisper.getModelStatus()
      if (!modelStatus?.exists) {
        const error: any = new Error('MODEL_NOT_DOWNLOADED')
        error.requiresDownload = true
        error.sessionId = session.username
        error.messageId = String(message.localId)
        throw error
      }

      const result = await window.electronAPI.chat.getVoiceTranscript(
          session.username,
          String(message.localId),
          message.createTime
      )

      if (result.success) {
        const transcriptText = (result.transcript || '').trim()
        voiceTranscriptCache.set(voiceTranscriptCacheKey, transcriptText)
        setVoiceTranscript(transcriptText)
      } else {
        if (result.error === 'SEGFAULT_ERROR') {
          console.warn('[ChatPage] 捕获到语音引擎底层段错误');

          setSystemAlert({
            title: '引擎崩溃提示',
            message: (
                <>
                  语音识别引擎发生底层崩溃 (Segmentation Fault)。<br /><br />
                  如果您使用的是 Linux 等自定义程度较高的系统，请检查 <code>sherpa-onnx</code> 的相关系统动态链接库 (如 glibc 等) 是否兼容。
                </>
            )
          });

        }

        setVoiceTranscriptError(true)
        voiceTranscriptRequestedRef.current = false
      }
    } catch (error: any) {
      // 检查是否是模型未下载错误
      if (error?.requiresDownload) {
        // 模型未下载，触发下载弹窗
        onRequireModelDownload?.(error.sessionId, error.messageId)
        // 不要重置 voiceTranscriptRequestedRef，避免重复触发
        setVoiceTranscriptLoading(false)
        return
      }
      setVoiceTranscriptError(true)
      voiceTranscriptRequestedRef.current = false
    } finally {
      setVoiceTranscriptLoading(false)
    }
  }, [message.createTime, message.localId, session.username, voiceTranscriptCacheKey, voiceTranscriptLoading, onRequireModelDownload])

  // 监听模型下载完成事件
  useEffect(() => {
    if (!isVoice) return

    const handleModelDownloaded = (event: CustomEvent) => {
      if (
        event.detail?.messageId === String(message.localId) &&
        (!event.detail?.sessionId || event.detail?.sessionId === session.username)
      ) {
        // 重置状态，允许重新尝试转写
        voiceTranscriptRequestedRef.current = false
        setVoiceTranscriptError(false)
        // 立即尝试转写
        void requestVoiceTranscript()
      }
    }

    window.addEventListener('model-downloaded', handleModelDownloaded as EventListener)
    return () => {
      window.removeEventListener('model-downloaded', handleModelDownloaded as EventListener)
    }
  }, [isVoice, message.localId, requestVoiceTranscript, session.username])

  // 视频懒加载
  const videoAutoLoadTriggered = useRef(false)
  const [videoClicked, setVideoClicked] = useState(false)

  useEffect(() => {
    if (!isVideo || !videoContainerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVideoVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '200px 0px',
        threshold: 0
      }
    )

    observer.observe(videoContainerRef.current)

    return () => observer.disconnect()
  }, [isVideo])

  // 视频加载中状态引用，避免依赖问题
  const videoLoadingRef = useRef(false)

  // 加载视频信息（添加重试机制）
  const requestVideoInfo = useCallback(async () => {
    if (!videoMd5 || videoLoadingRef.current) return

    videoLoadingRef.current = true
    setVideoLoading(true)
    try {
      const result = await window.electronAPI.video.getVideoInfo(videoMd5)
      if (result && result.success && result.exists) {
        setVideoInfo({
          exists: result.exists,
          videoUrl: result.videoUrl,
          coverUrl: result.coverUrl,
          thumbUrl: result.thumbUrl
        })
      } else {
        setVideoInfo({ exists: false })
      }
    } catch (err) {
      setVideoInfo({ exists: false })
    } finally {
      videoLoadingRef.current = false
      setVideoLoading(false)
    }
  }, [videoMd5])

  // 视频进入视野时自动加载
  useEffect(() => {
    if (!isVideo || !isVideoVisible) return
    if (videoInfo?.exists) return // 已成功加载，不需要重试
    if (videoAutoLoadTriggered.current) return

    videoAutoLoadTriggered.current = true
    void requestVideoInfo()
  }, [isVideo, isVideoVisible, videoInfo, requestVideoInfo])

  useEffect(() => {
    if (!autoTranscribeVoiceEnabled) return
    if (!isVoice) return
    if (!voiceDataUrl) return
    if (voiceTranscriptError) return
    if (voiceTranscriptLoading || voiceTranscript !== undefined || voiceTranscriptRequestedRef.current) return
    void requestVoiceTranscript()
  }, [autoTranscribeVoiceEnabled, isVoice, voiceDataUrl, voiceTranscript, voiceTranscriptError, voiceTranscriptLoading, requestVoiceTranscript])

  // 去除企业微信 ID 前缀
  const cleanMessageContent = useCallback((content: string) => {
    if (!content) return ''
    return content.replace(/^[a-zA-Z0-9]+@openim:\n?/, '')
  }, [])

  // 解析混合文本和表情
  const renderTextWithEmoji = useCallback((text: string) => {
    if (!text) return text
    const parts = text.split(/\[(.*?)\]/g)
    return parts.map((part, index) => {
      // 奇数索引是捕获组的内容（即括号内的文字）
      if (index % 2 === 1) {
        // @ts-ignore
        const path = getEmojiPath(part as any)
        if (path) {
          // path 例如 'assets/face/微笑.png'，需要添加 base 前缀
          return (
            <img
              key={index}
              src={`${import.meta.env.BASE_URL}${path}`}
              alt={`[${part}]`}
              className="inline-emoji"
              style={{ width: 22, height: 22, verticalAlign: 'bottom', margin: '0 1px' }}
            />
          )
        }
        return `[${part}]`
      }
      return part
    })
  }, [])

  const cleanedParsedContent = useMemo(
    () => cleanMessageContent(message.parsedContent || ''),
    [cleanMessageContent, message.parsedContent]
  )

  const appMsgRawXml = message.rawContent || message.parsedContent || ''
  const appMsgContainsTag = useMemo(
    () => appMsgRawXml.includes('<appmsg') || appMsgRawXml.includes('&lt;appmsg'),
    [appMsgRawXml]
  )
  const appMsgDoc = useMemo(() => {
    if (!appMsgContainsTag) return null
    try {
      const start = appMsgRawXml.indexOf('<msg>')
      const xml = start >= 0 ? appMsgRawXml.slice(start) : appMsgRawXml
      const doc = new DOMParser().parseFromString(xml, 'text/xml')
      if (doc.querySelector('parsererror')) return null
      return doc
    } catch {
      return null
    }
  }, [appMsgContainsTag, appMsgRawXml])
  const appMsgTextCache = useMemo(() => new Map<string, string>(), [appMsgDoc])
  const queryAppMsgText = useCallback((selector: string): string => {
    const cached = appMsgTextCache.get(selector)
    if (cached !== undefined) return cached
    const value = appMsgDoc?.querySelector(selector)?.textContent?.trim() || ''
    appMsgTextCache.set(selector, value)
    return value
  }, [appMsgDoc, appMsgTextCache])
  const queryPreferredQuotedContent = useCallback((): string => {
    if (message.quotedContent) return message.quotedContent
    const candidates = [
      'refermsg > selectedcontent',
      'refermsg > selectedtext',
      'refermsg > selectcontent',
      'refermsg > selecttext',
      'refermsg > quotecontent',
      'refermsg > quotetext',
      'refermsg > partcontent',
      'refermsg > parttext',
      'refermsg > excerpt',
      'refermsg > summary',
      'refermsg > preview',
      'refermsg > content'
    ]
    for (const selector of candidates) {
      const value = queryAppMsgText(selector)
      if (value) return value
    }
    return ''
  }, [message.quotedContent, queryAppMsgText])
  const appMsgThumbRawCandidate = useMemo(() => (
    message.linkThumb ||
    message.appMsgThumbUrl ||
    queryAppMsgText('appmsg > thumburl') ||
    queryAppMsgText('appmsg > cdnthumburl') ||
    queryAppMsgText('appmsg > cover') ||
    queryAppMsgText('appmsg > coverurl') ||
    queryAppMsgText('thumburl') ||
    queryAppMsgText('cdnthumburl') ||
    queryAppMsgText('cover') ||
    queryAppMsgText('coverurl') ||
    ''
  ).trim(), [message.linkThumb, message.appMsgThumbUrl, queryAppMsgText])
  const quotedSenderUsername = resolveQuotedSenderUsername(
    queryAppMsgText('refermsg > fromusr'),
    queryAppMsgText('refermsg > chatusr')
  )
  const quotedContent = queryPreferredQuotedContent()
  const quotedSenderFallbackName = useMemo(
    () => resolveQuotedSenderFallbackDisplayName(
      session.username,
      quotedSenderUsername,
      message.quotedSender || queryAppMsgText('refermsg > displayname') || ''
    ),
    [message.quotedSender, queryAppMsgText, quotedSenderUsername, session.username]
  )

  useEffect(() => {
    let cancelled = false
    const nextFallbackName = quotedSenderFallbackName || undefined
    setQuotedSenderName(nextFallbackName)

    if (!quotedContent || !quotedSenderUsername) {
      return () => {
        cancelled = true
      }
    }

    void resolveQuotedSenderDisplayName({
      sessionId: session.username,
      senderUsername: quotedSenderUsername,
      fallbackDisplayName: nextFallbackName,
      isGroupChat,
      myWxid
    }).then((resolvedName) => {
      if (cancelled) return
      setQuotedSenderName(resolvedName || nextFallbackName)
    })

    return () => {
      cancelled = true
    }
  }, [
    quotedContent,
    quotedSenderFallbackName,
    quotedSenderUsername,
    session.username,
    isGroupChat,
    myWxid
  ])

  useEffect(() => {
    let cancelled = false
    void configService.getQuoteLayout().then((layout) => {
      if (!cancelled) setQuoteLayout(layout)
    }).catch(() => {
      if (!cancelled) setQuoteLayout('quote-top')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const locationMessageMeta = useMemo(() => {
    if (message.localType !== 48) return null
    const raw = message.rawContent || ''
    const poiname = raw.match(/poiname="([^"]*)"/)?.[1] || message.locationPoiname || '位置'
    const label = raw.match(/label="([^"]*)"/)?.[1] || message.locationLabel || ''
    const lat = parseFloat(raw.match(/x="([^"]*)"/)?.[1] || String(message.locationLat || 0))
    const lng = parseFloat(raw.match(/y="([^"]*)"/)?.[1] || String(message.locationLng || 0))
    const zoom = 15
    const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom))
    const latRad = lat * Math.PI / 180
    const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom))
    const mapTileUrl = (lat && lng)
      ? `https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tileX}&y=${tileY}&z=${zoom}`
      : ''
    return { poiname, label, lat, lng, mapTileUrl }
  }, [message.localType, message.rawContent, message.locationPoiname, message.locationLabel, message.locationLat, message.locationLng])

  // 检测是否为链接卡片消息
  const isLinkMessage = String(message.localType) === '21474836529' || appMsgContainsTag
  const bubbleClass = isSent ? 'sent' : 'received'

  // 头像逻辑：
  // - 自己发的：优先使用 myAvatarUrl，缺失则用 senderAvatarUrl (补救)
  // - 群聊中对方发的：使用发送者头像
  // - 私聊中对方发的：使用会话头像
  const fallbackSenderName = String(message.senderDisplayName || message.senderUsername || '').trim() || undefined
  const resolvedSenderName = senderName || fallbackSenderName
  const resolvedSenderAvatarUrl = senderAvatarUrl || message.senderAvatarUrl
  const avatarUrl = isSent
    ? (myAvatarUrl || resolvedSenderAvatarUrl)
    : (isGroupChat ? resolvedSenderAvatarUrl : session.avatarUrl)

  // 是否有引用消息
  const hasQuote = quotedContent.length > 0
  const displayQuotedSenderName = quotedSenderName || quotedSenderFallbackName
  const renderBubbleWithQuote = useCallback((quotedNode: React.ReactNode, messageNode: React.ReactNode) => {
    const quoteFirst = quoteLayout !== 'quote-bottom'
    return (
      <div className={`bubble-content ${quoteFirst ? 'quote-layout-top' : 'quote-layout-bottom'}`}>
        {quoteFirst ? (
          <>
            {quotedNode}
            {messageNode}
          </>
        ) : (
          <>
            {messageNode}
            {quotedNode}
          </>
        )}
      </div>
    )
  }, [quoteLayout])

  const renderQuotedMessageBlock = useCallback((contentNode: React.ReactNode) => (
    <div className="quoted-message">
      {displayQuotedSenderName && <span className="quoted-sender">{displayQuotedSenderName}</span>}
      <span className="quoted-text">{contentNode}</span>
    </div>
  ), [displayQuotedSenderName])

  const handlePlayVideo = useCallback(async () => {
    if (!videoInfo?.videoUrl) return
    try {
      await window.electronAPI.window.openVideoPlayerWindow(videoInfo.videoUrl)
    } catch (e) {
      console.error('打开视频播放窗口失败:', e)
    }
  }, [videoInfo?.videoUrl])

  // Selection mode handling removed from here to allow normal rendering
  // We will wrap the output instead
  if (isSystem) {
    const isPatSystemMessage = message.localType === 266287972401
    const patTitleRaw = isPatSystemMessage
      ? (queryAppMsgText('appmsg > title') || queryAppMsgText('title') || message.parsedContent || '')
      : ''
    const patDisplayText = isPatSystemMessage
      ? cleanMessageContent(String(patTitleRaw).replace(/^\s*\[拍一拍\]\s*/i, ''))
      : ''
    const systemContentNode = isPatSystemMessage
      ? renderTextWithEmoji(patDisplayText || '拍一拍')
      : message.parsedContent

    return (
      <div
        className={`message-bubble system ${isSelectionMode ? 'selectable' : ''}`}
        onContextMenu={(e) => onContextMenu?.(e, message)}
        style={{ cursor: isSelectionMode ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
        onClick={(e) => {
          if (isSelectionMode) {
            e.stopPropagation()
            onToggleSelection?.(messageKey, e.shiftKey)
          }
        }}
      >
        {isSelectionMode && (
          <div className={`checkbox ${isSelected ? 'checked' : ''}`} style={{
            width: '20px',
            height: '20px',
            borderRadius: '4px',
            border: isSelected ? 'none' : '2px solid rgba(128,128,128,0.5)',
            backgroundColor: isSelected ? 'var(--primary)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            flexShrink: 0
          }}>
            {isSelected && <Check size={14} strokeWidth={3} />}
          </div>
        )}
        <div className="bubble-content">{systemContentNode}</div>
      </div>
    )
  }

  // 渲染消息内容
  const renderContent = () => {
    if (isImage) {
      return (
        <div
          ref={imageContainerRef}
          className={`image-stage ${imageStageLockHeight ? 'locked' : ''}`}
          style={imageStageLockStyle}
        >
          {imageLoading ? (
            <div className="image-loading">
              <Loader2 size={20} className="spin" />
            </div>
          ) : imageError || !imageLocalPath ? (
            <button
              className={`image-unavailable ${imageClicked ? 'clicked' : ''}`}
              onClick={handleImageClick}
              disabled={imageLoading}
              type="button"
            >
              <ImageIcon size={24} />
              <span>图片未解密</span>
              <span className="image-action">{imageClicked ? '已点击…' : '点击解密'}</span>
            </button>
          ) : (
            <>
              <div className="image-message-wrapper">
                <img
                  src={imageLocalPath}
                  alt="图片"
                  className={`image-message ${imageLoaded ? 'ready' : 'pending'}`}
                  onClick={() => { void handleOpenImageViewer() }}
                  onLoad={() => {
                    setImageLoaded(true)
                    setImageError(false)
                    stabilizeImageScrollAfterResize()
                    releaseImageStageLock()
                  }}
                  onError={() => {
                    imageResizeBaselineRef.current = null
                    setImageLoaded(false)
                    setImageError(true)
                    releaseImageStageLock()
                  }}
                />
                {imageLiveVideoPath && (
                  <div className="media-badge live">
                    <LivePhotoIcon size={14} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )
    }

    // 视频消息
    if (isVideo) {
      // 未进入可视区域时显示占位符
      if (!isVideoVisible) {
        return (
          <div className="video-placeholder" ref={videoContainerRef as React.RefObject<HTMLDivElement>}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
          </div>
        )
      }

      // 加载中
      if (videoLoading) {
        return (
          <div className="video-loading" ref={videoContainerRef as React.RefObject<HTMLDivElement>}>
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 视频不存在 - 添加点击重试功能
      if (!videoInfo?.exists || !videoInfo.videoUrl) {
        return (
          <button
            className={`video-unavailable ${videoClicked ? 'clicked' : ''}`}
            ref={videoContainerRef as React.RefObject<HTMLButtonElement>}
            onClick={() => {
              setVideoClicked(true)
              setTimeout(() => setVideoClicked(false), 800)
              videoAutoLoadTriggered.current = false
              void requestVideoInfo()
            }}
            type="button"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
            <span>视频未找到</span>
            <span className="video-action">{videoClicked ? '已点击…' : '点击重试'}</span>
          </button>
        )
      }

      // 默认显示缩略图，点击打开独立播放窗口
      const thumbSrc = videoInfo.thumbUrl || videoInfo.coverUrl
      return (
        <div className="video-thumb-wrapper" ref={videoContainerRef as React.RefObject<HTMLDivElement>} onClick={handlePlayVideo}>
          {thumbSrc ? (
            <img src={thumbSrc} alt="视频缩略图" className="video-thumb" />
          ) : (
            <div className="video-thumb-placeholder">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="23 7 16 12 23 17 23 7"></polygon>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
              </svg>
            </div>
          )}
          <div className="video-play-button">
            <Play size={32} fill="white" />
          </div>
        </div>
      )
    }

    if (isVoice) {
      const durationText = message.voiceDurationSeconds ? `${message.voiceDurationSeconds}"` : ''
      const handleToggle = async () => {
        if (voiceLoading) return
        const audio = voiceAudioRef.current || new Audio()
        if (!voiceAudioRef.current) {
          voiceAudioRef.current = audio
        }
        if (isVoicePlaying) {
          audio.pause()
          audio.currentTime = 0
          globalVoiceManager.stop(audio)
          return
        }
        if (!voiceDataUrl) {
          setVoiceLoading(true)
          setVoiceError(false)
          try {
            const result = await window.electronAPI.chat.getVoiceData(
              session.username,
              String(message.localId),
              message.createTime,
              message.serverIdRaw || message.serverId
            )
            if (result.success && result.data) {
              const url = `data:audio/wav;base64,${result.data}`
              voiceDataUrlCache.set(voiceCacheKey, url)
              setVoiceDataUrl(url)
            } else {
              setVoiceError(true)
              return
            }
          } catch {
            setVoiceError(true)
            return
          } finally {
            setVoiceLoading(false)
          }
        }
        const source = voiceDataUrlCache.get(voiceCacheKey) || voiceDataUrl
        if (!source) {
          setVoiceError(true)
          return
        }
        audio.src = source
        try {
          // 停止其他正在播放的语音，确保同一时间只播放一条
          globalVoiceManager.play(audio, () => {
            audio.pause()
            audio.currentTime = 0
          })
          await audio.play()
        } catch {
          setVoiceError(true)
        }
      }

      const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!voiceDataUrl || !voiceAudioRef.current) return
        e.stopPropagation()
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const percentage = x / rect.width
        const newTime = percentage * voiceDuration
        voiceAudioRef.current.currentTime = newTime
        setVoiceCurrentTime(newTime)
      }

      const showDecryptHint = !voiceDataUrl && !voiceLoading && !isVoicePlaying
      const showTranscript = Boolean(voiceDataUrl) && (voiceTranscriptLoading || voiceTranscriptError || voiceTranscript !== undefined)
      const transcriptText = (voiceTranscript || '').trim()
      const transcriptDisplay = voiceTranscriptLoading
        ? '转写中...'
        : voiceTranscriptError
          ? '转写失败，点击重试'
          : (transcriptText || '未识别到文字')
      const handleTranscriptRetry = () => {
        if (!voiceTranscriptError) return
        voiceTranscriptRequestedRef.current = false
        void requestVoiceTranscript()
      }

      return (
        <div className="voice-stack">
          <div className={`voice-message ${isVoicePlaying ? 'playing' : ''}`} onClick={handleToggle}>
            <button
              className="voice-play-btn"
              onClick={(e) => {
                e.stopPropagation()
                handleToggle()
              }}
              aria-label="播放语音"
              type="button"
            >
              {isVoicePlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <div className="voice-wave" onClick={handleSeek}>
              {voiceDataUrl && voiceWaveform.length > 0 ? (
                <div className="voice-waveform">
                  {voiceWaveform.map((amplitude, i) => {
                    const progress = (voiceCurrentTime / (voiceDuration || 1))
                    const isPlayed = (i / voiceWaveform.length) < progress
                    return (
                      <div
                        key={i}
                        className={`waveform-bar ${isPlayed ? 'played' : ''}`}
                        style={{ height: `${Math.max(20, amplitude * 100)}%` }}
                      />
                    )
                  })}
                </div>
              ) : (
                <div className="voice-wave-placeholder">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
            <div className="voice-info">
              <span className="voice-label">语音</span>
              {durationText && <span className="voice-duration">{durationText}</span>}
              {voiceLoading && <span className="voice-loading">解码中...</span>}
              {showDecryptHint && <span className="voice-hint">点击解密</span>}
              {voiceError && <span className="voice-error">播放失败</span>}
            </div>
            {/* 转文字按钮 */}
            {voiceDataUrl && !voiceTranscript && !voiceTranscriptLoading && (
              <button
                className="voice-transcribe-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  void requestVoiceTranscript()
                }}
                title="转文字"
                type="button"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            )}
          </div>
          {showTranscript && (
            <div
              className={`voice-transcript ${isSent ? 'sent' : 'received'}${voiceTranscriptError ? ' error' : ''}`}
              onClick={handleTranscriptRetry}
              title={voiceTranscriptError ? '点击重试语音转写' : undefined}
            >
              {voiceTranscriptError ? (
                '转写失败，点击重试'
              ) : !voiceTranscript ? (
                voiceTranscriptLoading ? '转写中...' : '未识别到文字'
              ) : (
                <AnimatedStreamingText
                  text={transcriptText}
                  loading={voiceTranscriptLoading}
                />
              )}
            </div>
          )}
        </div>
      )
    }

    // 名片消息
    if (isCard) {
      const cardName = message.cardNickname || message.cardUsername || '未知联系人'
      const cardAvatar = message.cardAvatarUrl
      return (
        <div className="card-message">
          <div className="card-icon">
            {cardAvatar ? (
              <img src={cardAvatar} alt="" style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '8px' }} referrerPolicy="no-referrer" />
            ) : (
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            )}
          </div>
          <div className="card-info">
            <div className="card-name">{cardName}</div>
            {message.cardUsername && message.cardUsername !== message.cardNickname && (
              <div className="card-wxid">微信号: {message.cardUsername}</div>
            )}
            <div className="card-label">个人名片</div>
          </div>
        </div>
      )
    }

    // 通话消息
    if (isCall) {
      return (
        <div className="bubble-content">
          <div className="call-message">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            <span>{message.parsedContent || '[通话]'}</span>
          </div>
        </div>
      )
    }

    // 位置消息
    if (message.localType === 48) {
      if (!locationMessageMeta) return null
      const { poiname, label, lat, lng, mapTileUrl } = locationMessageMeta
      return (
        <div className="location-message" onClick={() => window.electronAPI.shell.openExternal(`https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(poiname || label)}`)}>
          <div className="location-text">
            <div className="location-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            </div>
            <div className="location-info">
              {poiname && <div className="location-name">{poiname}</div>}
              {label && <div className="location-label">{label}</div>}
            </div>
          </div>
          {mapTileUrl && (
            <div className="location-map">
              <img src={mapTileUrl} alt="地图" referrerPolicy="no-referrer" />
            </div>
          )}
        </div>
      )
    }

    // 链接消息 (AppMessage)
    const appMsgRichPreview = (() => {
      const rawXml = appMsgRawXml
      if (!appMsgContainsTag) return null
      const q = queryAppMsgText

      const xmlType = message.xmlType || q('appmsg > type') || q('type')

      // type 62: 拍一拍（按普通文本渲染，支持 [烟花] 这类 emoji 占位符）
      if (xmlType === '62') {
        const patText = cleanMessageContent((q('title') || cleanedParsedContent || '').replace(/^\s*\[拍一拍\]\s*/i, ''))
        return <div className="bubble-content">{renderTextWithEmoji(patText || '拍一拍')}</div>
      }

      // type 57: 引用回复消息，解析 refermsg 渲染为引用样式
      if (xmlType === '57') {
        const replyText = q('title') || cleanedParsedContent || ''
        const referContent = queryPreferredQuotedContent()
        const referType = q('refermsg > type') || ''

        // 根据被引用消息类型渲染对应内容
        const renderReferContent = () => {
          // 动画表情：解析嵌套 XML 提取 cdnurl 渲染
          if (referType === '47') {
            try {
              const innerDoc = new DOMParser().parseFromString(referContent, 'text/xml')
              const cdnUrl = innerDoc.querySelector('emoji')?.getAttribute('cdnurl') || ''
              const md5 = innerDoc.querySelector('emoji')?.getAttribute('md5') || ''
              if (cdnUrl) return <QuotedEmoji cdnUrl={cdnUrl} md5={md5} />
            } catch { /* 解析失败降级 */ }
            return <span className="quoted-type-label">[动画表情]</span>
          }

          // 各类型名称映射
          const typeLabels: Record<string, string> = {
            '3': '图片', '34': '语音', '43': '视频',
            '49': '链接', '50': '通话', '10000': '系统消息', '10002': '撤回消息',
          }
          if (referType && typeLabels[referType]) {
            return <span className="quoted-type-label">[{typeLabels[referType]}]</span>
          }

          // 普通文本或未知类型
          return <>{renderTextWithEmoji(cleanMessageContent(referContent))}</>
        }

        return (
          renderBubbleWithQuote(
            renderQuotedMessageBlock(renderReferContent()),
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          )
        )
      }

      const title = message.linkTitle || q('title') || cleanedParsedContent || 'Card'
      const desc = message.appMsgDesc || q('des')
      const url = message.linkUrl || q('url')
      const fallbackThumbUrl = appMsgThumbRawCandidate
      const thumbUrl = isRenderableImageSrc(fallbackThumbUrl) ? fallbackThumbUrl : ''
      const musicUrl = message.appMsgMusicUrl || message.appMsgDataUrl || q('musicurl') || q('playurl') || q('dataurl') || q('lowurl')
      const sourceName = message.appMsgSourceName || q('sourcename')
      const sourceDisplayName = q('sourcedisplayname') || ''
      const appName = message.appMsgAppName || q('appname')
      const sourceUsername = message.appMsgSourceUsername || q('sourceusername')
      const finderName =
        message.finderNickname ||
        message.finderUsername ||
        q('findernickname') ||
        q('finder_nickname') ||
        q('finderusername') ||
        q('finder_username')

      const lower = rawXml.toLowerCase()

      const kind = message.appMsgKind || (
        (xmlType === '2001' || lower.includes('hongbao')) ? 'red-packet'
          : (xmlType === '115' ? 'gift'
            : ((xmlType === '33' || xmlType === '36') ? 'miniapp'
              : (((xmlType === '5' || xmlType === '49') && (sourceUsername.startsWith('gh_') || !!sourceName || appName.includes('公众号'))) ? 'official-link'
                : (xmlType === '51' ? 'finder'
                  : (xmlType === '3' ? 'music'
                    : ((xmlType === '5' || xmlType === '49') ? 'link' // Fallback for standard links
                      : (!!musicUrl ? 'music' : '')))))))
      )

      if (!kind) return null

      // 对视频号提取真实标题，避免出现 "当前版本不支持该内容"
      let displayTitle = title
      if (kind === 'finder' && (!displayTitle || displayTitle.includes('不支持'))) {
        displayTitle = q('finderFeed > desc') || q('finderFeed desc') || desc || ''
      }

      const openExternal = (e: React.MouseEvent, nextUrl?: string) => {
        if (!nextUrl) return
        e.stopPropagation()
        if (window.electronAPI?.shell?.openExternal) {
          window.electronAPI.shell.openExternal(nextUrl)
        } else {
          window.open(nextUrl, '_blank')
        }
      }

      const metaLabel =
        kind === 'red-packet' ? '红包'
          : kind === 'finder' ? (finderName || '视频号')
            : kind === 'location' ? '位置'
              : kind === 'music' ? (sourceName || appName || '音乐')
                : (sourceName || appName || (sourceUsername.startsWith('gh_') ? '公众号' : ''))

      const renderCard = (cardKind: string, clickableUrl?: string) => (
        <div
          className={`link-message appmsg-rich-card ${cardKind}`}
          onClick={clickableUrl ? (e) => openExternal(e, clickableUrl) : undefined}
          title={clickableUrl}
        >
          <div className="link-header">
            <div className="link-title" title={title}>{title}</div>
            {metaLabel ? <div className="appmsg-meta-badge">{metaLabel}</div> : null}
          </div>
          <div className="link-body">
            <div className="link-desc-block">
              {desc ? <div className="link-desc" title={desc}>{desc}</div> : null}
            </div>
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                className={`link-thumb${((cardKind === 'miniapp') || /\.svg(?:$|\?)/i.test(thumbUrl)) ? ' theme-adaptive' : ''}`}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : null}
          </div>
        </div>
      )

      if (kind === 'quote') {
        // 引用回复消息（appMsgKind='quote'，xmlType=57）
        const replyText = message.linkTitle || q('title') || cleanedParsedContent || ''
        const referContent = queryPreferredQuotedContent()
        return (
          renderBubbleWithQuote(
            renderQuotedMessageBlock(renderTextWithEmoji(cleanMessageContent(referContent))),
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          )
        )
      }

      if (kind === 'red-packet') {
        // 专属红包卡片
        const greeting = q('receivertitle') || q('sendertitle') || ''
        return (
          <div className="hongbao-message">
            <div className="hongbao-icon">
              <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                <rect x="4" y="6" width="32" height="28" rx="4" fill="white" fillOpacity="0.3" />
                <rect x="4" y="6" width="32" height="14" rx="4" fill="white" fillOpacity="0.2" />
                <circle cx="20" cy="20" r="6" fill="white" fillOpacity="0.4" />
                <text x="20" y="24" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">¥</text>
              </svg>
            </div>
            <div className="hongbao-info">
              <div className="hongbao-greeting">{greeting || '恭喜发财，大吉大利'}</div>
              <div className="hongbao-label">微信红包</div>
            </div>
          </div>
        )
      }

      if (kind === 'gift') {
        // 礼物卡片
        const giftImg = message.giftImageUrl || thumbUrl
        const giftWish = message.giftWish || title || '送你一份心意'
        const giftPriceRaw = message.giftPrice
        const giftPriceYuan = giftPriceRaw ? (parseInt(giftPriceRaw) / 100).toFixed(2) : ''
        return (
          <div className="gift-message">
            {giftImg && <img className="gift-img" src={giftImg} alt="" referrerPolicy="no-referrer" />}
            <div className="gift-info">
              <div className="gift-wish">{giftWish}</div>
              {giftPriceYuan && <div className="gift-price">¥{giftPriceYuan}</div>}
              <div className="gift-label">微信礼物</div>
            </div>
          </div>
        )
      }

      if (kind === 'finder') {
        // 视频号专属卡片
        const coverUrl = message.finderCoverUrl || thumbUrl
        const duration = message.finderDuration
        const authorName = finderName || ''
        const authorAvatar = message.finderAvatar
        const fmtDuration = duration ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : ''
        return (
          <div className="channel-video-card" onClick={url ? (e) => openExternal(e, url) : undefined}>
            <div className="channel-video-cover">
              {coverUrl ? (
                <img src={coverUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <div className="channel-video-cover-placeholder">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                </div>
              )}
              {fmtDuration && <span className="channel-video-duration">{fmtDuration}</span>}
            </div>
            <div className="channel-video-info">
              <div className="channel-video-title">{displayTitle || '视频号视频'}</div>
              <div className="channel-video-author">
                {authorAvatar && <img className="channel-video-avatar" src={authorAvatar} alt="" referrerPolicy="no-referrer" />}
                <span>{authorName || '视频号'}</span>
              </div>
            </div>
          </div>
        )
      }



      if (kind === 'music') {
        // 音乐专属卡片
        const albumUrl = message.musicAlbumUrl || thumbUrl
        const playUrl = message.musicUrl || musicUrl || url
        const songTitle = title || '未知歌曲'
        const artist = desc || ''
        const appLabel = sourceName || appName || ''
        return (
          <div className="music-message" onClick={playUrl ? (e) => openExternal(e, playUrl) : undefined}>
            <div className="music-cover">
              {albumUrl ? (
                <img src={albumUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
            </div>
            <div className="music-info">
              <div className="music-title">{songTitle}</div>
              {artist && <div className="music-artist">{artist}</div>}
              {appLabel && <div className="music-source">{appLabel}</div>}
            </div>
          </div>
        )
      }

      if (kind === 'official-link') {
        const authorAvatar = q('publisher > headimg') || q('brand_info > headimgurl') || q('appmsg > avatar') || q('headimgurl') || message.cardAvatarUrl
        const authorName = sourceDisplayName || q('publisher > nickname') || sourceName || appName || '公众号'
        const coverPic = q('mmreader > category > item > cover') || thumbUrl
        const digest = q('mmreader > category > item > digest') || desc
        const articleTitle = q('mmreader > category > item > title') || title

        return (
          <div className="official-message" onClick={url ? (e) => openExternal(e, url) : undefined}>
            <div className="official-header">
              {authorAvatar ? (
                <img src={authorAvatar} alt="" className="official-avatar" referrerPolicy="no-referrer" />
              ) : (
                <div className="official-avatar-placeholder">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
              )}
              <span className="official-name">{authorName}</span>
            </div>
            <div className="official-body">
              {coverPic ? (
                <div className="official-cover-wrapper">
                  <img src={coverPic} alt="" className="official-cover" referrerPolicy="no-referrer" />
                  <div className="official-title-overlay">{articleTitle}</div>
                </div>
              ) : (
                <div className="official-title-text">{articleTitle}</div>
              )}
              {digest && <div className="official-digest">{digest}</div>}
            </div>
          </div>
        )
      }

      if (kind === 'link') return renderCard('link', url || undefined)
      if (kind === 'card') return renderCard('card', url || undefined)
      if (kind === 'miniapp') {
        return (
          <div className="miniapp-message miniapp-message-rich">
            <div className="miniapp-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <div className="miniapp-info">
              <div className="miniapp-title">{title}</div>
              <div className="miniapp-label">{metaLabel || '小程序'}</div>
            </div>
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                className={`miniapp-thumb${/\.svg(?:$|\?)/i.test(thumbUrl) ? ' theme-adaptive' : ''}`}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : null}
          </div>
        )
      }
      return null
    })()

    if (appMsgRichPreview) {
      return appMsgRichPreview
    }

    if (appMsgContainsTag) {
      const q = queryAppMsgText
      const title = q('title') || '链接'
      const desc = q('des')
      const url = q('url')
      const appMsgType = message.xmlType || q('appmsg > type') || q('type')
      const textAnnouncement = q('textannouncement')
      const parsedDoc: Document | null = appMsgDoc

      // 引用回复消息 (type=57)，防止被误判为链接
      if (appMsgType === '57') {
        const replyText = parsedDoc?.querySelector('title')?.textContent?.trim() || cleanedParsedContent || ''
        const referContent = queryPreferredQuotedContent()
        const referType = parsedDoc?.querySelector('refermsg > type')?.textContent?.trim() || ''

        const renderReferContent2 = () => {
          if (referType === '47') {
            try {
              const innerDoc = new DOMParser().parseFromString(referContent, 'text/xml')
              const cdnUrl = innerDoc.querySelector('emoji')?.getAttribute('cdnurl') || ''
              const md5 = innerDoc.querySelector('emoji')?.getAttribute('md5') || ''
              if (cdnUrl) return <QuotedEmoji cdnUrl={cdnUrl} md5={md5} />
            } catch { /* 解析失败降级 */ }
            return <span className="quoted-type-label">[动画表情]</span>
          }
          const typeLabels: Record<string, string> = {
            '3': '图片', '34': '语音', '43': '视频',
            '49': '链接', '50': '通话', '10000': '系统消息', '10002': '撤回消息',
          }
          if (referType && typeLabels[referType]) {
            return <span className="quoted-type-label">[{typeLabels[referType]}]</span>
          }
          return <>{renderTextWithEmoji(cleanMessageContent(referContent))}</>
        }

        return (
          renderBubbleWithQuote(
            renderQuotedMessageBlock(renderReferContent2()),
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          )
        )
      }

      // 群公告消息 (type=87)
      if (appMsgType === '87') {
        const announcementText = textAnnouncement || desc || '群公告'
        return (
          <div className="announcement-message">
            <div className="announcement-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
            <div className="announcement-content">
              <div className="announcement-label">群公告</div>
              <div className="announcement-text">{announcementText}</div>
            </div>
          </div>
        )
      }

      // 聊天记录 (type=19)
      if (appMsgType === '19') {
        const recordList = message.chatRecordList || []
        const displayTitle = title || '群聊的聊天记录'
        const metaText =
          recordList.length > 0
            ? `共 ${recordList.length} 条聊天记录`
            : desc || '聊天记录'

        const previewItems = buildChatRecordPreviewItems(recordList, 3)
        const remainingCount = Math.max(0, recordList.length - previewItems.length)

        return (
          <div
            className="chat-record-message"
            onClick={(e) => {
              e.stopPropagation()
              // 打开聊天记录窗口
              window.electronAPI.window.openChatHistoryWindow(session.username, message.localId)
            }}
            title="点击查看详细聊天记录"
          >
            <div className="chat-record-title" title={displayTitle}>
              {displayTitle}
            </div>
            <div className="chat-record-meta-line" title={metaText}>
              {metaText}
            </div>
            {previewItems.length > 0 ? (
              <div className="chat-record-list">
                {previewItems.map((item, i) => (
                  <div key={i} className="chat-record-item">
                    <span className="source-name">
                      {hasRenderableChatRecordName(item.sourcename) ? `${item.sourcename}: ` : ''}
                    </span>
                    {getChatRecordPreviewText(item)}
                  </div>
                ))}
                {remainingCount > 0 && (
                  <div className="chat-record-more">还有 {remainingCount} 条…</div>
                )}
              </div>
            ) : (
              <div className="chat-record-desc">
                {desc || '点击打开查看完整聊天记录'}
              </div>
            )}
            <div className="chat-record-footer">聊天记录</div>
          </div>
        )
      }

      // 文件消息 (type=6)
      if (appMsgType === '6') {
        const fileName = message.fileName || title || '文件'
        const fileSize = message.fileSize
        const fileExt = message.fileExt || fileName.split('.').pop()?.toLowerCase() || ''

        // 根据扩展名选择图标
        const getFileIcon = () => {
          const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2']
          if (archiveExts.includes(fileExt)) {
            return (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )
          }
          return (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
          )
        }

        return (
          <div className="file-message">
            <div className="file-icon">
              {getFileIcon()}
            </div>
            <div className="file-info">
              <div className="file-name" title={fileName}>{fileName}</div>
              <div className="file-meta">
                {fileSize ? formatFileSize(fileSize) : ''}
              </div>
            </div>
          </div>
        )
      }

      // 转账消息 (type=2000)
      if (appMsgType === '2000') {
        try {
          // 使用外层已解析好的 parsedDoc（已去除 wxid 前缀）
          const feedesc = parsedDoc?.querySelector('feedesc')?.textContent || ''
          const payMemo = parsedDoc?.querySelector('pay_memo')?.textContent || ''
          const paysubtype = parsedDoc?.querySelector('paysubtype')?.textContent || '1'

          // paysubtype: 1=待收款, 3=已收款
          const isReceived = paysubtype === '3'

          // 如果 feedesc 为空，使用 title 作为降级
          const displayAmount = feedesc || title || '微信转账'

          // 构建转账描述：A 转账给 B
          const transferDesc = transferPayerName && transferReceiverName
            ? `${transferPayerName} 转账给 ${transferReceiverName}`
            : undefined

          return (
            <div className={`transfer-message ${isReceived ? 'received' : ''}`}>
              <div className="transfer-icon">
                {isReceived ? (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20l6 6 10-12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className="transfer-info">
                <div className="transfer-amount">{displayAmount}</div>
                {transferDesc && <div className="transfer-desc">{transferDesc}</div>}
                {payMemo && <div className="transfer-memo">{payMemo}</div>}
                <div className="transfer-label">{isReceived ? '已收款' : '微信转账'}</div>
              </div>
            </div>
          )
        } catch (e) {
          console.error('[Transfer Debug] Parse error:', e)
          // 解析失败时的降级处理
          const feedesc = title || '微信转账'
          return (
            <div className="transfer-message">
              <div className="transfer-icon">
                <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                  <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="transfer-info">
                <div className="transfer-amount">{feedesc}</div>
                <div className="transfer-label">微信转账</div>
              </div>
            </div>
          )
        }
      }

      // 小程序 (type=33/36)
      if (appMsgType === '33' || appMsgType === '36') {
        return (
          <div className="miniapp-message">
            <div className="miniapp-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <div className="miniapp-info">
              <div className="miniapp-title">{title}</div>
              <div className="miniapp-label">小程序</div>
            </div>
          </div>
        )
      }

      // 有 URL 的链接消息
      if (url) {
        return (
          <div
            className="link-message"
            onClick={(e) => {
              e.stopPropagation()
              if (window.electronAPI?.shell?.openExternal) {
                window.electronAPI.shell.openExternal(url)
              } else {
                window.open(url, '_blank')
              }
            }}
          >
            <div className="link-header">
              <div className="link-title" title={title}>{title}</div>
            </div>
            <div className="link-body">
              <div className="link-desc" title={desc}>{desc}</div>
            </div>
          </div>
        )
      }
    }

    // 表情包消息
    if (isEmoji) {
      // ... (keep existing emoji logic)
      // 没有 cdnUrl 或加载失败，显示占位符
      if ((!message.emojiCdnUrl && !message.emojiLocalPath) || emojiError) {
        return (
          <div className="emoji-message-wrapper" ref={emojiContainerRef}>
            <div className="emoji-unavailable">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 15s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
              <span>表情包未缓存</span>
            </div>
          </div>
        )
      }

      // 显示加载中
      if (emojiLoading || !emojiLocalPath) {
        return (
          <div className="emoji-message-wrapper" ref={emojiContainerRef}>
            <div className="emoji-loading">
              <Loader2 size={20} className="spin" />
            </div>
          </div>
        )
      }

      // 显示表情图片
      return (
        <div className="emoji-message-wrapper" ref={emojiContainerRef}>
          <img
            src={emojiLocalPath}
            alt="表情"
            className="emoji-image"
            onLoad={() => {
              setEmojiError(false)
              stabilizeEmojiScrollAfterResize()
            }}
            onError={() => {
              emojiResizeBaselineRef.current = null
              setEmojiError(true)
            }}
          />
        </div>
      )
    }

    // 解析引用消息（Links / App Messages）
    // localType: 21474836529 corresponds to AppMessage which often contains links

    // 带引用的消息
    if (hasQuote) {
      return renderBubbleWithQuote(
        renderQuotedMessageBlock(renderTextWithEmoji(cleanMessageContent(quotedContent))),
        <div className="message-text">{renderTextWithEmoji(cleanedParsedContent)}</div>
      )
    }

    // 普通消息
    return <div className="bubble-content">{renderTextWithEmoji(cleanedParsedContent)}</div>
  }

  return (
    <>
      {showTime && (
        <div className="time-divider">
          <span>{formatTime(message.createTime)}</span>
        </div>
      )}
      <div
        className={`message-wrapper-with-selection ${isSelectionMode ? 'selectable' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          width: '100%',
          justifyContent: isSent ? 'flex-end' : 'flex-start',
          cursor: isSelectionMode ? 'pointer' : 'default'
        }}
        onClick={(e) => {
          if (isSelectionMode) {
            e.stopPropagation()
            onToggleSelection?.(messageKey, e.shiftKey)
          }
        }}
      >
        {isSelectionMode && !isSent && (
          <div className={`checkbox ${isSelected ? 'checked' : ''}`} style={{
            width: '20px',
            height: '20px',
            borderRadius: '4px',
            border: isSelected ? 'none' : '2px solid rgba(128,128,128,0.5)',
            backgroundColor: isSelected ? 'var(--primary)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            marginRight: '12px',
            marginTop: '10px', // Align with avatar top
            flexShrink: 0
          }}>
            {isSelected && <Check size={14} strokeWidth={3} />}
          </div>
        )}

        <div className={`message-bubble ${bubbleClass} ${isEmoji && message.emojiCdnUrl && !emojiError ? 'emoji' : ''} ${isImage ? 'image' : ''} ${isVoice ? 'voice' : ''}`}
          onContextMenu={(e) => onContextMenu?.(e, message)}
        >
          <div className="bubble-avatar">
            <Avatar
              src={avatarUrl}
              name={!isSent ? (isGroupChat ? (resolvedSenderName || '?') : (session.displayName || session.username)) : '我'}
              size={36}
              className="bubble-avatar"
            />
          </div>
          <div className="bubble-body">
            {/* 群聊中显示发送者名称 */}
            {isGroupChat && !isSent && (
              <div className="sender-name">
                {resolvedSenderName || '群成员'}
              </div>
            )}
            {renderContent()}
          </div>
        </div>

        {isSelectionMode && isSent && (
          <div className={`checkbox ${isSelected ? 'checked' : ''}`} style={{
            width: '20px',
            height: '20px',
            borderRadius: '4px',
            border: isSelected ? 'none' : '2px solid rgba(128,128,128,0.5)',
            backgroundColor: isSelected ? 'var(--primary)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            marginLeft: '12px',
            marginTop: '10px',
            flexShrink: 0
          }}>
            {isSelected && <Check size={14} strokeWidth={3} />}
          </div>
        )}
        {systemAlert && createPortal(
            <div className="modal-overlay" onClick={() => setSystemAlert(null)} style={{ zIndex: 99999 }}>
              <div className="delete-confirm-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
                <div className="confirm-icon">
                  <AlertCircle size={32} color="var(--danger)" />
                </div>
                <div className="confirm-content">
                  <h3>{systemAlert.title}</h3>
                  <p style={{ marginTop: '12px', lineHeight: '1.6', fontSize: '14px', color: 'var(--text-secondary)' }}>
                    {systemAlert.message}
                  </p>
                </div>
                <div className="confirm-actions" style={{ justifyContent: 'center', marginTop: '24px' }}>
                  <button
                      className="btn-primary"
                      onClick={() => setSystemAlert(null)}
                      style={{ padding: '8px 32px' }}
                  >
                    确认
                  </button>
                </div>
              </div>
            </div>,
            document.body
        )}
      </div>
    </>
  )
}

const MemoMessageBubble = React.memo(MessageBubble, (prevProps, nextProps) => {
  if (prevProps.message !== nextProps.message) return false
  if (prevProps.messageKey !== nextProps.messageKey) return false
  if (prevProps.showTime !== nextProps.showTime) return false
  if (prevProps.myAvatarUrl !== nextProps.myAvatarUrl) return false
  if (prevProps.myWxid !== nextProps.myWxid) return false
  if (prevProps.isGroupChat !== nextProps.isGroupChat) return false
  if (prevProps.autoTranscribeVoiceEnabled !== nextProps.autoTranscribeVoiceEnabled) return false
  if (prevProps.isSelectionMode !== nextProps.isSelectionMode) return false
  if (prevProps.isSelected !== nextProps.isSelected) return false
  if (prevProps.onRequireModelDownload !== nextProps.onRequireModelDownload) return false
  if (prevProps.onContextMenu !== nextProps.onContextMenu) return false
  if (prevProps.onToggleSelection !== nextProps.onToggleSelection) return false

  return (
    prevProps.session.username === nextProps.session.username &&
    prevProps.session.displayName === nextProps.session.displayName &&
    prevProps.session.avatarUrl === nextProps.session.avatarUrl
  )
})

export default ChatPage
