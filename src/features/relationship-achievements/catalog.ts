import type { RelationshipAchievementDefinition } from './types'

const whenLocalRecordReaches = (thresholdLabel: string) =>
  `本地记录达到${thresholdLabel}时解锁。`

/**
 * Every entry is an independent memory achievement. Similar metrics deliberately
 * use different names, copy and motifs instead of rank/level language.
 */
export const RELATIONSHIP_ACHIEVEMENT_CATALOG = [
  {
    id: 'first_page',
    category: 'beginning',
    metric: 'firstMessage',
    source: 'sessionStats',
    threshold: 1,
    title: '你好，陌生人',
    goalCopy: '发送出你们的第一条消息',
    unlockedCopy: '多年以后，你还会记得那个初次对话的瞬间吗？',
    lockedCopy: '本地记录中出现最早一条可识别的私聊消息时解锁',
    badge: { motif: 'folded-page-bubble', palette: 'dawn', engraving: '初' }
  },
  {
    id: 'messages_100',
    category: 'conversation',
    metric: 'totalMessages',
    source: 'sessionStats',
    threshold: 100,
    title: '渐渐熟悉的头像',
    goalCopy: '私聊消息达到 100 条',
    unlockedCopy: '一百次一来一回，日子还长，有无数个一百句可以慢慢讲',
    lockedCopy: whenLocalRecordReaches(' 100 条私聊消息'),
    badge: { motif: 'two-bubbles-form-profile', palette: 'apricot', engraving: '百' }
  },
  {
    id: 'messages_1000',
    category: 'conversation',
    metric: 'totalMessages',
    source: 'sessionStats',
    threshold: 1_000,
    title: '废话才是最大的浪漫',
    goalCopy: '私聊消息达到 1,000 条',
    unlockedCopy: '还记得曾经无话不说的那些日子吗？',
    lockedCopy: whenLocalRecordReaches(' 1,000 条私聊消息'),
    badge: { motif: 'speech-dots-form-river', palette: 'coral', engraving: '千' }
  },
  {
    id: 'messages_10000',
    category: 'conversation',
    metric: 'totalMessages',
    source: 'sessionStats',
    threshold: 10_000,
    title: '刻进日常的习惯',
    goalCopy: '私聊消息达到 10,000 条',
    unlockedCopy: '不管白天经历了什么，总有一个人会在意你的开心和失落',
    lockedCopy: whenLocalRecordReaches(' 10,000 条私聊消息'),
    badge: { motif: 'lit-window-made-of-bubbles', palette: 'rose', engraving: '万' }
  },
  {
    id: 'messages_50000',
    category: 'conversation',
    metric: 'totalMessages',
    source: 'sessionStats',
    threshold: 50_000,
    title: '岁月的长卷',
    goalCopy: '私聊消息达到 50,000 条',
    unlockedCopy: '总是以为岁月取之不尽，却忘了此刻不会重来',
    lockedCopy: whenLocalRecordReaches(' 50,000 条私聊消息'),
    badge: { motif: 'endless-thread-through-two-bubbles', palette: 'berry', engraving: '长' }
  },
  {
    id: 'active_days_7',
    category: 'presence',
    metric: 'activeDays',
    source: 'messageDateCounts',
    threshold: 7,
    title: '这一周，有你在',
    goalCopy: '在 7 个不同的日子里留下痕迹',
    unlockedCopy: '一种奇妙的默契，就这样悄悄在你们之间生根发芽',
    lockedCopy: whenLocalRecordReaches(' 7 个有消息的自然日'),
    badge: { motif: 'seven-dots-around-bubble', palette: 'butter', engraving: '七' }
  },
  {
    id: 'active_days_30',
    category: 'presence',
    metric: 'activeDays',
    source: 'messageDateCounts',
    threshold: 30,
    title: '翻过一页日历',
    goalCopy: '在 30 个不同的日子里留下痕迹',
    unlockedCopy: '很多事情显得有趣，是因为有个不无聊的人陪着你',
    lockedCopy: whenLocalRecordReaches(' 30 个有消息的自然日'),
    badge: { motif: 'calendar-with-scattered-marks', palette: 'tangerine', engraving: '卅' }
  },
  {
    id: 'active_days_100',
    category: 'presence',
    metric: 'activeDays',
    source: 'messageDateCounts',
    threshold: 100,
    title: '百日如一',
    goalCopy: '有消息的自然日达到 100 天',
    unlockedCopy: '一百天的陪伴，早已把对方写进了每天必不可少的日程里',
    lockedCopy: whenLocalRecordReaches(' 100 个有消息的自然日'),
    badge: { motif: 'calendar-tiles-form-page', palette: 'amber', engraving: '百日' }
  },
  {
    id: 'active_days_365',
    category: 'presence',
    metric: 'activeDays',
    source: 'messageDateCounts',
    threshold: 365,
    title: '借走你的一年',
    goalCopy: '有消息的自然日达到 365 天',
    unlockedCopy: '原来，我们已经一起走过了这么长的路',
    lockedCopy: whenLocalRecordReaches(' 365 个有消息的自然日'),
    badge: { motif: 'full-calendar-orbit-around-two-dots', palette: 'amber-sky', engraving: '年日' }
  },
  {
    id: 'streak_3',
    category: 'continuity',
    metric: 'longestStreakDays',
    source: 'messageDateCounts',
    threshold: 3,
    title: '意犹未尽的昨日',
    goalCopy: '连续 3 天未曾断联',
    unlockedCopy: '昨晚没说完的话，顺理成章地成为了第二天早晨第一句问候的理由。',
    lockedCopy: whenLocalRecordReaches('连续 3 个自然日有消息'),
    badge: { motif: 'three-connected-lanterns', palette: 'mint', engraving: '三日' }
  },
  {
    id: 'streak_7',
    category: 'continuity',
    metric: 'longestStreakDays',
    source: 'messageDateCounts',
    threshold: 7,
    title: '没有句号的一周',
    goalCopy: '连续 7 天未曾断联',
    unlockedCopy: '你说，我在',
    lockedCopy: whenLocalRecordReaches('连续 7 个自然日有消息'),
    badge: { motif: 'unbroken-seven-day-arc', palette: 'jade', engraving: '一周' }
  },
  {
    id: 'streak_30',
    category: 'continuity',
    metric: 'longestStreakDays',
    source: 'messageDateCounts',
    threshold: 30,
    title: '戒不掉的依赖',
    goalCopy: '连续有消息达到 30 天',
    unlockedCopy: '日复一日的聊天，让你们的距离更近了一些',
    lockedCopy: whenLocalRecordReaches('连续 30 个自然日有消息'),
    badge: { motif: 'moon-orbiting-bubble', palette: 'jade-indigo', engraving: '月' }
  },
  {
    id: 'images_100',
    category: 'keepsake',
    metric: 'imageMessages',
    source: 'sessionStats',
    threshold: 100,
    title: '定格的风景',
    goalCopy: '发送图片达到 100 张',
    unlockedCopy: '当你有一天来到了照片里的那个地方，会想起曾经的对方分享时的情景吗？',
    lockedCopy: whenLocalRecordReaches(' 100 张图片'),
    badge: { motif: 'open-window-photo-corner', palette: 'sky', engraving: '景' }
  },
  {
    id: 'voices_50',
    category: 'keepsake',
    metric: 'voiceMessages',
    source: 'sessionStats',
    threshold: 50,
    title: '听见你的语气',
    goalCopy: '发送语音达到 50 条',
    unlockedCopy: '让声音代替你陪在身边吧',
    lockedCopy: whenLocalRecordReaches(' 50 条语音'),
    badge: { motif: 'waveform-inside-bubble', palette: 'periwinkle', engraving: '声' }
  },
  {
    id: 'videos_20',
    category: 'keepsake',
    metric: 'videoMessages',
    source: 'sessionStats',
    threshold: 20,
    title: '封存的时间切片',
    goalCopy: '发送视频达到 20 条',
    unlockedCopy: '每一次播放，都像是做了一场短暂回到过去的梦',
    lockedCopy: whenLocalRecordReaches(' 20 条视频'),
    badge: { motif: 'tiny-film-window-play', palette: 'lavender', engraving: '刻' }
  },
  {
    id: 'emojis_200',
    category: 'keepsake',
    metric: 'emojiMessages',
    source: 'sessionStats',
    threshold: 200,
    title: '无声的默契',
    goalCopy: '发送表情达到 200 个',
    unlockedCopy: '那些欲言又止的想念、不敢言说的失落，最后都化作了一个个动画表情',
    lockedCopy: whenLocalRecordReaches(' 200 个表情'),
    badge: { motif: 'spark-face-inside-bubble', palette: 'lemon-rose', engraving: '懂' }
  },
  {
    id: 'files_10',
    category: 'keepsake',
    metric: 'fileMessages',
    source: 'sessionStats',
    threshold: 10,
    title: '有你在，没意外',
    goalCopy: '发送文件达到 10 个',
    unlockedCopy: '那些共同完成过的任务，如今成了证明我们曾并肩作战的遗迹',
    lockedCopy: whenLocalRecordReaches(' 10 个文件'),
    badge: { motif: 'folded-document-tied-thread', palette: 'slate-blue', engraving: '笺' }
  },
  {
    id: 'calls_5',
    category: 'keepsake',
    metric: 'callMessages',
    source: 'sessionStats',
    threshold: 5,
    title: '靠在耳边的岁月',
    goalCopy: '语音或视频通话达到 5 次',
    unlockedCopy: '声音和画面里，你们的距离比现实更近',
    lockedCopy: whenLocalRecordReaches(' 5 次语音或视频通话记录'),
    badge: { motif: 'receiver-two-sound-rings', palette: 'deep-cyan', engraving: '话' }
  },
  {
    id: 'common_groups_1',
    category: 'connection',
    metric: 'privateMutualGroups',
    source: 'sessionStats',
    threshold: 1,
    title: '千万人海的相遇',
    goalCopy: '拥有 1 个双方共同群聊',
    unlockedCopy: '茫茫人海中，我们曾坐在同一个屋檐下',
    lockedCopy: whenLocalRecordReaches(' 1 个双方共同群聊'),
    badge: { motif: 'round-table-two-chairs', palette: 'soft-violet', engraving: '同席' }
  },
  {
    id: 'common_groups_3',
    category: 'connection',
    metric: 'privateMutualGroups',
    source: 'sessionStats',
    threshold: 3,
    title: '重叠的命运',
    goalCopy: '拥有 3 个双方共同群聊',
    unlockedCopy: '不同的圈子，相同的你我',
    lockedCopy: whenLocalRecordReaches(' 3 个双方共同群聊'),
    badge: { motif: 'three-overlapping-windows', palette: 'blue-violet', engraving: '交叠' }
  },
  {
    id: 'span_365',
    category: 'time',
    metric: 'conversationSpanDays',
    source: 'sessionStats',
    threshold: 365,
    title: '长情的岁月',
    goalCopy: '首末消息相隔 365 个自然日',
    unlockedCopy: '四季已经轮转。这漫长的一年里，哪怕有过短暂的空白，幸好我们始终没有走散',
    lockedCopy: whenLocalRecordReaches('首末消息相隔 365 个自然日'),
    badge: { motif: 'page-corners-sun-moon', palette: 'amber-navy', engraving: '后来' }
  },
  {
    id: 'years_2',
    category: 'time',
    metric: 'activeYears',
    source: 'messageDateCounts',
    threshold: 2,
    title: '又陪你过了一年',
    goalCopy: '在 2 个不同自然年留下消息',
    unlockedCopy: '零点的钟声敲响，旧的日历被撕下，新的一年里依然是你',
    lockedCopy: whenLocalRecordReaches(' 2 个有消息的不同自然年'),
    badge: { motif: 'two-calendar-pages-joined-by-thread', palette: 'winter-blue-peach', engraving: '跨年' }
  },
  {
    id: 'years_3',
    category: 'time',
    metric: 'activeYears',
    source: 'messageDateCounts',
    threshold: 3,
    title: '三秋之绊',
    goalCopy: '在 3 个不同自然年留下消息',
    unlockedCopy: '很高兴，三年后我们依然在这里',
    lockedCopy: whenLocalRecordReaches(' 3 个有消息的不同自然年'),
    badge: { motif: 'three-annual-rings-speech-sprout', palette: 'forest-gold', engraving: '三年' }
  },
  {
    id: 'years_5',
    category: 'time',
    metric: 'activeYears',
    source: 'messageDateCounts',
    threshold: 5,
    title: '岁月偷不走的Ta',
    goalCopy: '在 5 个不同自然年留下消息',
    unlockedCopy: '五年了，你还记得我们第一次聊天的那个瞬间吗？',
    lockedCopy: whenLocalRecordReaches(' 5 个有消息的不同自然年'),
    badge: { motif: 'tree-rings-embrace-two-bubbles', palette: 'twilight-navy-gold', engraving: '岁月' }
  }
] as const satisfies readonly RelationshipAchievementDefinition[]

export type RelationshipAchievementId = typeof RELATIONSHIP_ACHIEVEMENT_CATALOG[number]['id']

export const RELATIONSHIP_ACHIEVEMENT_COUNT = RELATIONSHIP_ACHIEVEMENT_CATALOG.length

/**
 * Titles and copy for the timeline-only achievements that are discovered while
 * scanning messages. Keep these together with the metric achievement catalog so
 * product copy can be edited without touching detection code or page components.
 */
export const RELATIONSHIP_JOURNEY_MOMENT_CONTENT = {
  'long-conversation': {
    title: '忘了时间的漫游',
    copy: '某天也许你会无端想起那个热烈的下午，还记得你们聊了些什么吗？',
    goalCopy: '连续对话达到 45 分钟且双方都参与'
  },
  'late-night-conversation': {
    title: '深夜电台',
    copy: '你怎么还没睡？',
    goalCopy: '深夜持续对话达到 30 分钟且双方都参与'
  },
  'mutual-images': {
    title: '拼凑彼此的世界',
    copy: '你发去一阵风，他回赠一朵云，短暂地踏入了对方此刻的人生。',
    goalCopy: '双方都曾在对话中发送图片'
  },
  'first-voice': {
    title: '初次听见你',
    copy: '那时的语气、呼吸和心跳，定格在了那条几秒钟的语音里',
    goalCopy: '留下第一条语音消息'
  },
  'new-year-together': {
    title: '偷走新年的第一秒',
    copy: '烟花升起，旧年落幕。在这承前启后的特殊时刻，我们曾用一条消息开启了彼此的明天',
    goalCopy: '跨年时段双方持续留在同一段对话中'
  },
  'return-after-silence': {
    title: '兜兜转转，依然是你',
    copy: '记录里曾有过一段漫长的留白。但后来的某一天，一句轻轻的“在吗”，让停滞的时光再次转动。',
    goalCopy: '间隔 30 天后双方重新开始对话'
  },
  'first-argument': {
    title: '第一次争吵',
    copy: ' 因为在乎才会展露锋芒',
    goalCopy: '首次明确的双方争执通过语义复核'
  },
  'first-reconciliation': {
    title: '缝补后的拥抱',
    copy: '没有谁非要赢，只是不想失去你。',
    goalCopy: '争执后出现明确缓和、回应与稳定交流'
  },
  'back-and-forth': {
    title: '懂你意思',
    copy: '那种奇妙的同频共振，仿佛共享着同一个大脑。',
    goalCopy: '单段对话交替发言达到 30 次，且双方各至少 10 条'
  },
  'across-midnight': {
    title: '偷走明天的时光',
    copy: '只要都不说晚安，今天仿佛就永远不会结束。',
    goalCopy: '连续对话跨过零点，双方合计达到 20 条消息'
  },
  'monthly-continuity': {
    title: '十二个月的圆满',
    copy: '翻过春夏秋冬的每一页，都曾写过你的名字。',
    goalCopy: '连续 12 个自然月都有消息'
  },
  'four-seasons': {
    title: '走过四季',
    copy: '春天的花，夏天的雨，秋天的落叶，冬天的雪，那一年我们没有缺席过彼此的四季',
    goalCopy: '同一自然年的四个季度都有消息'
  },
  'photo-diary': {
    title: '日常碎片收集者',
    copy: '路边的猫、好看的云，因为有你一起看，那些日常才闪闪发光',
    goalCopy: '在 30 个不同日期里双方都发送过图片'
  },
  'mutual-initiators': {
    title: '互相的惦记',
    copy: '主动开口这种事，我们都为对方做了很多次。',
    goalCopy: '双方各自主动开启新对话达到 10 次'
  },
  'warm-after-silence': {
    title: '仿佛不曾离开',
    copy: '于是我们奋力向前、逆水行舟，直至回到往昔岁月',
    goalCopy: '连续 90 天无聊天后，7 天内双方合计达到 100 条且各至少 10 条'
  },
  'peak-day': {
    title: '情绪沸腾的盛夏',
    copy: '这是记录中消息最密集的一天。不管那天发生了什么，你们似乎恨不得把一辈子的废话都在这一天说完。',
    goalCopy: '成为当前记录中消息数量最多的一天'
  }
} as const

export type RelationshipJourneyMomentContentId = keyof typeof RELATIONSHIP_JOURNEY_MOMENT_CONTENT

/** Central access point for every relationship achievement title and copy. */
export class RelationshipAchievementContent {
  static getAllAchievements(): readonly RelationshipAchievementDefinition[] {
    return RELATIONSHIP_ACHIEVEMENT_CATALOG
  }

  static getAchievement(id: RelationshipAchievementId): RelationshipAchievementDefinition {
    const definition = RELATIONSHIP_ACHIEVEMENT_CATALOG.find((item) => item.id === id)
    if (!definition) throw new Error(`Unknown relationship achievement: ${id}`)
    return definition
  }

  static getJourneyMoment(id: RelationshipJourneyMomentContentId) {
    return RELATIONSHIP_JOURNEY_MOMENT_CONTENT[id]
  }
}
