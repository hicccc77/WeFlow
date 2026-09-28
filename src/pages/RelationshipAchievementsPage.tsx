import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  CloudLightning,
  RefreshCw,
} from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Avatar } from '../components/Avatar'
import {
  buildRelationshipJourneyViewModel,
  clearRelationshipJourneyScanCache,
  createRelationshipAchievementsLoadingState,
  createRelationshipJourneyScanLoadingState,
  evaluateRelationshipAchievements,
  isEligiblePrivateFriendSession,
  loadRelationshipAchievements,
  loadRelationshipJourneyMoments,
  RelationshipAchievementContent,
  type ExportSessionAchievementStats,
  type RelationshipAchievementCollection,
  type RelationshipJourneyMoment,
  type RelationshipJourneyNode,
  type RelationshipJourneyScanResult
} from '../features/relationship-achievements'
import * as configService from '../services/config'
import { displayNameOrFallback } from '../utils/displayName'
import './RelationshipAchievementsPage.scss'

interface RelationshipAchievementsPageProps {
  demo?: boolean
}

interface RelationshipProfile {
  displayName: string
  avatarUrl?: string
  selfAvatarUrl?: string
  selfAccountId?: string
}

interface RelationshipRouteState {
  displayName?: string
  avatarUrl?: string
}

const buildDemoDateCounts = (): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const year of [2023, 2024, 2025, 2026]) {
    for (let index = 0; index < 32; index += 1) {
      const date = new Date(Date.UTC(year, 0, 2 + index * 10))
      counts[date.toISOString().slice(0, 10)] = 18 + ((index * 17 + year) % 86)
    }
  }
  for (let day = 3; day <= 11; day += 1) {
    counts[`2025-10-${String(day).padStart(2, '0')}`] = 96 + day * 3
  }
  return counts
}

const DEMO_STATS: ExportSessionAchievementStats = {
  totalMessages: 12_684,
  voiceMessages: 86,
  imageMessages: 318,
  videoMessages: 14,
  emojiMessages: 243,
  fileMessages: 6,
  transferMessages: 0,
  redPacketMessages: 0,
  callMessages: 3,
  firstTimestamp: Math.floor(new Date('2023-01-02T08:30:00+08:00').getTime() / 1_000),
  lastTimestamp: Math.floor(new Date('2026-01-15T21:18:00+08:00').getTime() / 1_000),
  privateMutualGroups: 2
}

const timestamp = (value: string): number => Math.floor(new Date(value).getTime() / 1_000)

const buildDemoCollection = (): RelationshipAchievementCollection =>
  evaluateRelationshipAchievements('demo-friend', {
    sessionStats: { status: 'ready', value: DEMO_STATS },
    messageDateCounts: { status: 'ready', value: buildDemoDateCounts() }
  }, {
    evaluatedAt: Date.now(),
    dataQuality: { statsUpdatedAt: Date.now(), statsStale: false, statsNeedsRefresh: false }
  })

const buildDemoScan = (): RelationshipJourneyScanResult => {
  const argumentAt = timestamp('2024-08-17T22:26:00+08:00')
  const argumentId = `first-argument:${argumentAt}`
  const moments: RelationshipJourneyMoment[] = [
    {
      id: `long-conversation:${timestamp('2023-02-12T19:10:00+08:00')}`,
      kind: 'long-conversation',
      state: 'observed',
      occurredAt: timestamp('2023-02-12T19:10:00+08:00'),
      endedAt: timestamp('2023-02-12T22:03:00+08:00'),
      ...RelationshipAchievementContent.getJourneyMoment('long-conversation'),
      evidence: '一段连续对话持续 2 小时 53 分钟，双方共留下 147 条记录'
    },
    {
      id: `mutual-images:${timestamp('2023-04-09T14:28:00+08:00')}`,
      kind: 'mutual-images',
      state: 'observed',
      occurredAt: timestamp('2023-04-09T14:28:00+08:00'),
      ...RelationshipAchievementContent.getJourneyMoment('mutual-images'),
      evidence: '当前本地记录里，你和对方都曾发来过图片'
    },
    {
      id: `first-voice:${timestamp('2023-07-21T18:42:00+08:00')}`,
      kind: 'first-voice',
      state: 'observed',
      occurredAt: timestamp('2023-07-21T18:42:00+08:00'),
      ...RelationshipAchievementContent.getJourneyMoment('first-voice'),
      evidence: '当前本地记录里最早的一条可识别语音记录'
    },
    {
      id: `late-night-conversation:${timestamp('2024-03-03T00:18:00+08:00')}`,
      kind: 'late-night-conversation',
      state: 'observed',
      occurredAt: timestamp('2024-03-03T00:18:00+08:00'),
      endedAt: timestamp('2024-03-03T02:07:00+08:00'),
      ...RelationshipAchievementContent.getJourneyMoment('late-night-conversation'),
      evidence: '深夜持续 1 小时 49 分钟，双方都在回应'
    },
    {
      id: argumentId,
      kind: 'first-argument',
      state: 'observed',
      occurredAt: argumentAt,
      endedAt: timestamp('2024-08-18T00:02:00+08:00'),
      ...RelationshipAchievementContent.getJourneyMoment('first-argument'),
      evidence: '本地规则先找到候选；AI 复核确认负向表达明确互相指向双方，且语境足够、置信度达到 91%'
    },
    {
      id: `first-reconciliation:${timestamp('2024-08-18T10:16:00+08:00')}`,
      kind: 'first-reconciliation',
      state: 'observed',
      occurredAt: timestamp('2024-08-18T10:16:00+08:00'),
      parentId: argumentId,
      ...RelationshipAchievementContent.getJourneyMoment('first-reconciliation'),
      evidence: '已确认的冲突片段之后出现明确缓和表达、对方回应与后续稳定交流'
    },
    {
      id: `return-after-silence:${timestamp('2025-02-11T09:03:00+08:00')}`,
      kind: 'return-after-silence',
      state: 'observed',
      occurredAt: timestamp('2025-02-11T09:03:00+08:00'),
      ...RelationshipAchievementContent.getJourneyMoment('return-after-silence'),
      evidence: '当前本地记录曾留白 42 天，恢复后一天内双方都再次留下消息'
    },
    {
      id: `peak-day:${timestamp('2025-10-07T08:12:00+08:00')}`,
      kind: 'peak-day',
      state: 'observed',
      occurredAt: timestamp('2025-10-07T08:12:00+08:00'),
      ...RelationshipAchievementContent.getJourneyMoment('peak-day'),
      evidence: '2025-10-07 共留下 306 条本地记录'
    }
  ]

  return {
    status: 'ready',
    moments,
    thresholdReachedAt: {
      first_page: timestamp('2023-01-02T08:30:00+08:00'),
      messages_100: timestamp('2023-01-12T21:40:00+08:00'),
      active_days_7: timestamp('2023-01-26T12:08:00+08:00'),
      messages_1000: timestamp('2023-05-18T22:11:00+08:00'),
      active_days_30: timestamp('2023-07-02T15:06:00+08:00'),
      active_days_100: timestamp('2024-11-08T10:30:00+08:00'),
      span_365: timestamp('2024-01-02T08:31:00+08:00'),
      years_2: timestamp('2024-01-03T09:22:00+08:00'),
      messages_10000: timestamp('2025-09-19T19:27:00+08:00')
    },
    scannedMessages: 12_684,
    truncated: false,
    semanticReview: {
      status: 'complete',
      reviewed: 1,
      accepted: 1
    }
  }
}

const formatJourneyDate = (value?: number): string => {
  if (!value) return '达成日期待整理'
  const date = new Date(value * 1_000)
  if (Number.isNaN(date.getTime())) return '达成日期待整理'
  return `于 ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日达成`
}

const displayNumber = (value?: number): string => Number.isFinite(value)
  ? Number(value).toLocaleString('zh-CN')
  : '—'

const itemMetricValue = (collection: RelationshipAchievementCollection, metric: string): number | undefined =>
  collection.achievements.find((item) => item.definition.metric === metric)?.evidence?.current

function JourneyNodeView({
  node
}: {
  node: RelationshipJourneyNode
}) {
  const isMainline = node.lane === 'mainline'

  return (
    <li className={`relationship-journey-node is-${node.lane} is-${node.state} side-${node.side}`}>
      <div className="relationship-journey-node-axis" aria-hidden="true">
        {isMainline ? (
          <span className="relationship-journey-main-marker" />
        ) : (
          <span className="relationship-journey-branch-marker" />
        )}
      </div>

      <article className="relationship-journey-node-story">
        <h3>{node.title}</h3>
        <p>{node.copy}</p>
        <div className="relationship-journey-achievement-footer">
          <span className="relationship-journey-achievement-goal">{node.goalCopy}</span>
          <time dateTime={node.occurredAt ? new Date(node.occurredAt * 1_000).toISOString() : undefined}>
            {formatJourneyDate(node.occurredAt)}
          </time>
        </div>
      </article>
    </li>
  )
}

function JourneySkeleton() {
  return (
    <div className="relationship-journey-skeleton" aria-hidden="true">
      <span className="relationship-journey-skeleton-line" aria-hidden="true" />
      {Array.from({ length: 5 }).map((_, index) => (
        <span key={index} className={`relationship-journey-skeleton-node node-${index + 1}`} aria-hidden="true" />
      ))}
    </div>
  )
}

const FOG_DEPTHS = [1, 2, 3] as const

function JourneyFog({ futureState }: { futureState: 'locked' | 'unknown' | 'unwritten' }) {
  const fogCopy = futureState === 'locked'
    ? {
        eyebrow: '未涉足的远方',
        title: '答案留在抵达的那天',
        description: '时间在前方埋下了许多彩蛋，但此刻它们被温柔地藏在雾中。不用着急，当你们并肩走到那里时，它自然会为你们亮起。'
      }
    : futureState === 'unknown'
      ? {
          eyebrow: '蒙尘的坐标',
          title: '记忆暂时迷了路',
          description: '岁月积攒得太厚，有几块旧时光的拼图暂时散落在了雾里。试着重新整理一下本地的记录，风会再次把迷雾吹散的。'
        }
      : {
          eyebrow: '无垠的旷野',
          title: '接下来的路，没有剧本',
          description: '数字与代码的地图只能画到这里，但这片留白之外，是你们真实的人生。去吧，下一件刻骨铭心的事，不该由我们来提前命名。'
        }

  return (
    <li className={`relationship-journey-fog-zone is-${futureState}`}>
      <div className="relationship-journey-fog-caption">
        <span>{fogCopy.eyebrow}</span>
        <h3>{fogCopy.title}</h3>
        <p>{fogCopy.description}</p>
      </div>

      <div className="relationship-journey-fog-art" aria-hidden="true">
        <span className="relationship-journey-fog-thread" />
        {FOG_DEPTHS.map((depth) => (
          <div
            key={depth}
            className={`relationship-journey-fog-landmark depth-${depth} side-${depth % 2 === 0 ? 'end' : 'start'}`}
          >
            <span className="relationship-journey-fog-checkpoint" />
            <span className="relationship-journey-fog-silhouette">
              <span />
              <span />
              <span />
            </span>
          </div>
        ))}
        <span className="relationship-journey-fog-bank bank-one" />
        <span className="relationship-journey-fog-bank bank-two" />
        <span className="relationship-journey-fog-bank bank-three" />
      </div>
    </li>
  )
}

export default function RelationshipAchievementsPage({ demo = false }: RelationshipAchievementsPageProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams<{ sessionId?: string }>()
  const routeState = location.state as RelationshipRouteState | null
  const isDemo = demo || new URLSearchParams(location.search).get('demo') === '1'
  const sessionId = isDemo ? 'demo-friend' : decodeURIComponent(String(params.sessionId || '').trim())
  const requestSequenceRef = useRef(0)
  const forceJourneyScanRef = useRef(false)
  const pendingJourneyFocusRef = useRef<'refresh' | null>(null)
  const [previewMode, setPreviewMode] = useState<'light' | 'dark'>('light')
  const [profile, setProfile] = useState<RelationshipProfile>({
    displayName: isDemo ? '林屿' : displayNameOrFallback(sessionId, routeState?.displayName),
    avatarUrl: isDemo ? undefined : routeState?.avatarUrl
  })
  const [collection, setCollection] = useState<RelationshipAchievementCollection>(() => (
    isDemo ? buildDemoCollection() : createRelationshipAchievementsLoadingState(sessionId)
  ))
  const [scan, setScan] = useState<RelationshipJourneyScanResult>(() => (
    isDemo ? buildDemoScan() : createRelationshipJourneyScanLoadingState()
  ))

  useEffect(() => {
    if (!isDemo) return
    const previousMode = document.documentElement.getAttribute('data-mode')
    const previousTheme = document.documentElement.getAttribute('data-theme')
    document.documentElement.setAttribute('data-mode', previewMode)
    document.documentElement.setAttribute('data-theme', 'default')
    return () => {
      previousMode === null
        ? document.documentElement.removeAttribute('data-mode')
        : document.documentElement.setAttribute('data-mode', previousMode)
      previousTheme === null
        ? document.documentElement.removeAttribute('data-theme')
        : document.documentElement.setAttribute('data-theme', previousTheme)
    }
  }, [isDemo, previewMode])

  const load = useCallback(async (forceRefresh = false) => {
    const requestSequence = ++requestSequenceRef.current
    if (isDemo) {
      setCollection(buildDemoCollection())
      setScan(buildDemoScan())
      setProfile({ displayName: '林屿' })
      return
    }

    if (forceRefresh) {
      forceJourneyScanRef.current = true
      clearRelationshipJourneyScanCache(sessionId)
    }

    setCollection(createRelationshipAchievementsLoadingState(sessionId))
    setScan(createRelationshipJourneyScanLoadingState())
    try {
      const selfAccountId = await configService.getMyAccountId()
      const [nextCollection, detailResult, selfAvatarResult] = await Promise.all([
        loadRelationshipAchievements(
          { sessionId, selfAccountId: selfAccountId || undefined },
          { allowStaleCache: !forceRefresh, forceRefresh }
        ),
        window.electronAPI.chat.getSessionDetailFast(sessionId),
        window.electronAPI.chat.getMyAvatarUrl()
      ])

      if (requestSequence !== requestSequenceRef.current) return
      const detail = detailResult.success ? detailResult.detail : undefined
      setProfile({
        displayName: displayNameOrFallback(
          sessionId,
          detail?.remark,
          detail?.nickName,
          detail?.displayName,
          routeState?.displayName,
          detail?.alias
        ),
        avatarUrl: detail?.avatarUrl || routeState?.avatarUrl,
        selfAvatarUrl: selfAvatarResult.success ? selfAvatarResult.avatarUrl : undefined,
        selfAccountId: selfAccountId || undefined
      })
      setCollection(nextCollection)
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) return
      setCollection(evaluateRelationshipAchievements(sessionId, {
        sessionStats: { status: 'error', error: String(error) },
        messageDateCounts: { status: 'error', error: String(error) }
      }, { evaluatedAt: Date.now() }))
    }
  }, [isDemo, routeState?.avatarUrl, routeState?.displayName, sessionId])

  useEffect(() => {
    void load(false)
    return () => {
      requestSequenceRef.current += 1
    }
  }, [load])

  useEffect(() => {
    if (isDemo || collection.summary.loading === collection.summary.total) return
    if (
      collection.summary.total > 0 &&
      collection.summary.error === collection.summary.total
    ) {
      forceJourneyScanRef.current = false
      setScan({
        status: 'error',
        moments: [],
        thresholdReachedAt: {},
        scannedMessages: 0,
        truncated: false,
        error: collection.errors[0] || '当前没有读到可用于共同旅程的本地统计'
      })
      return
    }
    if (!isEligiblePrivateFriendSession({ sessionId, selfAccountId: profile.selfAccountId })) {
      forceJourneyScanRef.current = false
      setScan({
        status: 'error',
        moments: [],
        thresholdReachedAt: {},
        scannedMessages: 0,
        truncated: false,
        error: '共同旅程只整理单个好友的私聊记录'
      })
      return
    }
    const controller = new AbortController()
    const forceRefresh = forceJourneyScanRef.current
    forceJourneyScanRef.current = false
    const totalMessageEvidence = collection.achievements.find(
      (item) => item.definition.metric === 'totalMessages'
    )?.evidence
    const firstPageEvidence = collection.achievements.find(
      (item) => item.definition.id === 'first_page'
    )?.evidence
    const spanEvidence = collection.achievements.find(
      (item) => item.definition.id === 'span_365'
    )?.evidence
    const cacheKey = [
      sessionId,
      profile.selfAccountId ?? '',
      totalMessageEvidence?.current ?? '',
      firstPageEvidence?.firstDate ?? '',
      spanEvidence?.lastDate ?? ''
    ].join(':')
    setScan(createRelationshipJourneyScanLoadingState())
    void loadRelationshipJourneyMoments(sessionId, {
      signal: controller.signal,
      cacheKey,
      forceRefresh
    }).then((result) => {
      if (!controller.signal.aborted) {
        setScan(result)
      }
    }).catch((error) => {
      if (controller.signal.aborted || error?.name === 'AbortError') return
      setScan({
        status: 'error',
        moments: [],
        thresholdReachedAt: {},
        scannedMessages: 0,
        truncated: false,
        error: String(error)
      })
    })
    return () => {
      controller.abort()
      void window.electronAPI.chat.cancelRelationshipJourneyMoments?.(sessionId)
    }
  }, [collection.evaluatedAt, collection.summary.loading, collection.summary.total, isDemo, profile.selfAccountId, sessionId])

  const journey = useMemo(
    () => buildRelationshipJourneyViewModel(collection, scan),
    [collection, scan]
  )
  const spanDays = itemMetricValue(collection, 'conversationSpanDays')
  const activeDays = itemMetricValue(collection, 'activeDays')
  const totalMessages = itemMetricValue(collection, 'totalMessages')
  const firstDate = collection.achievements.find((item) => item.definition.id === 'first_page')?.evidence?.firstDate
  const spanEvidence = collection.achievements.find((item) => item.definition.id === 'span_365')?.evidence
  const lastDate = spanEvidence?.lastDate
  const allLoading = collection.summary.loading === collection.summary.total
  const journeyLoading = journey.quality !== 'unavailable' && (
    allLoading || (!isDemo && scan.status === 'loading')
  )
  const hasErrors = collection.errors.length > 0

  useEffect(() => {
    if (journeyLoading || pendingJourneyFocusRef.current === null) return
    pendingJourneyFocusRef.current = null
    window.requestAnimationFrame(() => {
      document.getElementById('relationship-journey-refresh')?.focus({ preventScroll: true })
    })
  }, [journeyLoading])

  const reloadJourney = () => {
    pendingJourneyFocusRef.current = 'refresh'
    void load(true)
  }

  const handleBack = () => {
    if (isDemo) {
      if (window.history.length > 1) navigate(-1)
      return
    }
    navigate(-1)
  }

  return (
    <div className={`relationship-achievements-page${isDemo ? ' is-demo' : ''}`}>
      {isDemo ? (
        <div className="relationship-demo-toolbar" aria-label="演示预览主题">
          <span>共同旅程 Demo</span>
          <button className={previewMode === 'light' ? 'active' : ''} onClick={() => setPreviewMode('light')} type="button">
            浅色
          </button>
          <button className={previewMode === 'dark' ? 'active' : ''} onClick={() => setPreviewMode('dark')} type="button">
            深色
          </button>
        </div>
      ) : null}
      <div className="relationship-achievements-scroll">
        <header className="relationship-journey-hero">
          <div className="relationship-journey-topbar">
            <button type="button" className="relationship-journey-back" onClick={handleBack} aria-label="返回聊天">
              <ArrowLeft size={18} aria-hidden="true" />
              <span>返回聊天</span>
            </button>
            <button
              type="button"
              id="relationship-journey-refresh"
              className="relationship-journey-refresh"
              onClick={reloadJourney}
              disabled={journeyLoading}
              aria-label={journeyLoading ? '正在整理共同旅程' : '重新整理共同旅程'}
            >
              <RefreshCw size={15} className={journeyLoading ? 'spin' : ''} aria-hidden="true" />
              <span>{journeyLoading ? '正在整理' : '重新走一遍'}</span>
            </button>
          </div>

          <div className="relationship-journey-cover">
            <div className="relationship-journey-portraits" aria-hidden="true">
              <span className="relationship-journey-portrait-ring ring-one" />
              <span className="relationship-journey-portrait-ring ring-two" />
              <Avatar src={profile.selfAvatarUrl} name="我" size={56} className="relationship-journey-self" />
              <span className="relationship-journey-portrait-thread" />
              <Avatar src={profile.avatarUrl} name={profile.displayName} size={70} className="relationship-journey-friend" />
            </div>
            <div className="relationship-journey-cover-copy">
              <span className="relationship-journey-kicker">共同旅程 · 当前本地记录</span>
              <h1>与{profile.displayName}的共同旅程</h1>
              <p className="relationship-journey-cover-summary">
                从 <em>{firstDate || '本地最早的一页'}</em> 到 <em>{lastDate || '最近留下的一句'}</em>，
                这段记录跨过了 <strong>{displayNumber(spanDays)}</strong> 天。
                其中有 <strong>{displayNumber(activeDays)}</strong> 个日子里有过对话，
                一共留下 <strong>{displayNumber(totalMessages)}</strong> 条消息。
              </p>
            </div>
          </div>
        </header>

        <main className="relationship-journey-main" id="relationship-journey-main">
          {hasErrors ? (
            <div className="relationship-journey-alert" role="alert">
              <AlertCircle size={18} />
              <div>
                <strong>这条路有一部分暂时没有读到</strong>
                <span>{collection.errors[0]}。已经读到的节点仍会留在原处。</span>
              </div>
              <button type="button" onClick={reloadJourney} disabled={journeyLoading}>重试</button>
            </div>
          ) : null}

          {journeyLoading ? (
            <JourneySkeleton />
          ) : journey.quality === 'unavailable' ? (
            <section className="relationship-journey-unavailable" role="status">
              <span className="relationship-journey-unavailable-mark" aria-hidden="true">
                <CloudLightning size={24} />
              </span>
              <h3>这条共同旅程暂时无法展开</h3>
              <p>当前没有读到足够的本地会话统计。你的聊天内容没有被改变，可以稍后重新整理。</p>
              <button type="button" onClick={reloadJourney}>重新整理</button>
            </section>
          ) : (
            <section
              id="relationship-journey-map"
              className="relationship-journey-map"
              aria-label={`和 ${profile.displayName} 的共同旅程`}
              tabIndex={-1}
            >
              <span className="relationship-journey-path" aria-hidden="true" />
              <ol>
                {journey.nodes.map((node) => (
                  <JourneyNodeView
                    key={node.id}
                    node={node}
                  />
                ))}

                <li className="relationship-journey-node is-current side-end" aria-current="step">
                  <div className="relationship-journey-node-axis" aria-hidden="true">
                    <span className="relationship-journey-current-marker" />
                  </div>
                  <article className="relationship-journey-node-story">
                    <div className="relationship-journey-node-meta">
                      <time>{lastDate || '最近一条本地记录'}</time>
                      <span>故事写到这里</span>
                    </div>
                    <h3>你们现在站在这里</h3>
                    <p>前面那些节点并没有把关系讲完。它们只是让回头看时，知道这段路确实被一步步走过。</p>
                  </article>
                </li>

                <JourneyFog futureState={journey.futureState} />
              </ol>
            </section>
          )}

          <footer className="relationship-journey-footer">
            <p>所有“第一次”都只表示当前设备仍保存的记录里最早的一次。敏感片段先在本地形成候选，只有 AI 明确判断为双方真实冲突后才会出现；记录上的留白不是疏远，雾中的轮廓也不是待完成的任务。</p>
          </footer>
        </main>
      </div>
    </div>
  )
}
