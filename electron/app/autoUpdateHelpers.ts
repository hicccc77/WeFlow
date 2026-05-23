import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { ConfigService } from '../services/config'

export const AUTO_UPDATE_ENABLED =
  process.env.AUTO_UPDATE_ENABLED === 'true' ||
  process.env.AUTO_UPDATE_ENABLED === '1' ||
  (process.env.AUTO_UPDATE_ENABLED == null && !process.env.VITE_DEV_SERVER_URL)

export const inferUpdateTrackFromVersion = (version: string): 'stable' | 'preview' | 'dev' => {
  const normalized = String(version || '').trim().replace(/^v/i, '')
  if (/^0\.\d{2}\.\d+$/i.test(normalized)) return 'preview'
  if (/^\d{2}\.\d{1,2}\.\d{1,2}$/i.test(normalized)) return 'dev'
  if (/-preview\.\d+\.\d+$/i.test(normalized)) return 'preview'
  if (/-dev\.\d+\.\d+\.\d+$/i.test(normalized)) return 'dev'
  if (/(alpha|beta|rc)/i.test(normalized)) return 'dev'
  return 'stable'
}

const normalizeUpdateTrack = (raw: unknown): 'stable' | 'preview' | 'dev' | null => {
  if (raw === 'stable' || raw === 'preview' || raw === 'dev') return raw
  return null
}

const getUpdaterFeedUrlByTrack = (track: 'stable' | 'preview' | 'dev'): string => {
  const repoBase = 'https://github.com/hicccc77/WeFlow/releases'
  if (track === 'stable') return `${repoBase}/latest/download`
  if (track === 'preview') return `${repoBase}/download/nightly-preview`
  return `${repoBase}/download/nightly-dev`
}

const resetUpdaterProviderCache = () => {
  const updater = autoUpdater as any
  for (const key of ['clientPromise', '_clientPromise', 'updateInfoAndProvider']) {
    if (Object.prototype.hasOwnProperty.call(updater, key)) {
      updater[key] = null
    }
  }
}

const normalizeReleaseNotes = (rawReleaseNotes: unknown): string => {
  const merged = (() => {
    if (typeof rawReleaseNotes === 'string') {
      return rawReleaseNotes
    }
    if (Array.isArray(rawReleaseNotes)) {
      return rawReleaseNotes
        .map((item) => {
          if (!item || typeof item !== 'object') return ''
          const note = (item as { note?: unknown }).note
          return typeof note === 'string' ? note : ''
        })
        .filter(Boolean)
        .join('\n\n')
    }
    return ''
  })()

  if (!merged.trim()) return ''

  const normalizeHeadingText = (raw: string): string => {
    return raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, '\'')
      .replace(/&#x27;/gi, '\'')
      .toLowerCase()
      .replace(/[：:]/g, '')
      .replace(/\s+/g, '')
      .trim()
  }

  const shouldStripReleaseSection = (headingRaw: string): boolean => {
    const heading = normalizeHeadingText(headingRaw)
    if (!heading) return false
    if (heading.startsWith('下载') || heading.startsWith('download')) return true

    if ((heading.includes('macos') || heading.startsWith('mac')) && heading.includes('安装提示')) return true
    return false
  }

  const removeDownloadSectionFromHtml = (input: string): string => {
    const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
    const headings: Array<{ start: number; end: number; headingText: string }> = []
    let match: RegExpExecArray | null

    while ((match = headingPattern.exec(input)) !== null) {
      const full = match[0]
      headings.push({
        start: match.index,
        end: match.index + full.length,
        headingText: match[2] || ''
      })
    }

    if (headings.length === 0) return input

    const rangesToRemove: Array<{ start: number; end: number }> = []
    for (let i = 0; i < headings.length; i += 1) {
      const current = headings[i]
      if (!shouldStripReleaseSection(current.headingText)) continue

      const nextStart = i + 1 < headings.length ? headings[i + 1].start : input.length
      rangesToRemove.push({ start: current.start, end: nextStart })
    }

    if (rangesToRemove.length === 0) return input

    let output = ''
    let cursor = 0
    for (const range of rangesToRemove) {
      output += input.slice(cursor, range.start)
      cursor = range.end
    }
    output += input.slice(cursor)
    return output
  }

  const removeDownloadSectionFromMarkdown = (input: string): string => {
    const lines = input.split(/\r?\n/)
    const output: string[] = []
    let skipSection = false

    for (const line of lines) {
      const headingMatch = line.match(/^\s*#{1,6}\s*(.+?)\s*$/)
      if (headingMatch) {
        if (shouldStripReleaseSection(headingMatch[1])) {
          skipSection = true
          continue
        }
        if (skipSection) {
          skipSection = false
        }
      }
      if (!skipSection) {
        output.push(line)
      }
    }

    return output.join('\n')
  }

  const cleaned = removeDownloadSectionFromMarkdown(removeDownloadSectionFromHtml(merged))
    .replace(/^[ \t>*-]*`?\s*xattr\s+-[a-z]*d[a-z]*\s+com\.apple\.quarantine[^\n]*`?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned
}

export function createAutoUpdateHelpers(getConfigService: () => ConfigService | null) {
  const appVersion = app.getVersion()
  const defaultUpdateTrack: 'stable' | 'preview' | 'dev' = (() => {
    const inferred = inferUpdateTrackFromVersion(appVersion)
    if (inferred === 'preview' || inferred === 'dev') return inferred
    return 'stable'
  })()

  let lastAppliedUpdaterChannel: string | null = null
  let lastAppliedUpdaterFeedUrl: string | null = null
  let isDownloadInProgress = false
  let downloadProgressHandler: ((progress: any) => void) | null = null
  let downloadedHandler: (() => void) | null = null

  const getEffectiveUpdateTrack = (): 'stable' | 'preview' | 'dev' => {
    const configuredTrack = normalizeUpdateTrack(getConfigService()?.get('updateChannel'))
    return configuredTrack || defaultUpdateTrack
  }

  const isRemoteVersionNewer = (latestVersion: string, currentVersion: string): boolean => {
    const latest = String(latestVersion || '').trim()
    const current = String(currentVersion || '').trim()
    if (!latest || !current) return false

    const parseVersion = (version: string) => {
      const normalized = version.replace(/^v/i, '')
      const [main, pre = ''] = normalized.split('-', 2)
      const core = main.split('.').map((segment) => Number.parseInt(segment, 10) || 0)
      const prerelease = pre ? pre.split('.').map((segment) => /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment) : []
      return { core, prerelease }
    }

    const compareParsedVersion = (a: ReturnType<typeof parseVersion>, b: ReturnType<typeof parseVersion>): number => {
      const maxLen = Math.max(a.core.length, b.core.length)
      for (let i = 0; i < maxLen; i += 1) {
        const left = a.core[i] || 0
        const right = b.core[i] || 0
        if (left > right) return 1
        if (left < right) return -1
      }

      const aPre = a.prerelease
      const bPre = b.prerelease
      if (aPre.length === 0 && bPre.length === 0) return 0
      if (aPre.length === 0) return 1
      if (bPre.length === 0) return -1

      const preMaxLen = Math.max(aPre.length, bPre.length)
      for (let i = 0; i < preMaxLen; i += 1) {
        const left = aPre[i]
        const right = bPre[i]
        if (left === undefined) return -1
        if (right === undefined) return 1
        if (left === right) continue

        const leftNum = typeof left === 'number'
        const rightNum = typeof right === 'number'
        if (leftNum && rightNum) return left > right ? 1 : -1
        if (leftNum) return -1
        if (rightNum) return 1
        return String(left) > String(right) ? 1 : -1
      }

      return 0
    }

    try {
      return autoUpdater.currentVersion.compare(latest) < 0
    } catch {
      return compareParsedVersion(parseVersion(latest), parseVersion(current)) > 0
    }
  }

  const shouldOfferUpdateForTrack = (latestVersion: string, currentVersion: string): boolean => {
    if (isRemoteVersionNewer(latestVersion, currentVersion)) return true
    const effectiveTrack = getEffectiveUpdateTrack()
    const currentTrack = inferUpdateTrackFromVersion(currentVersion)
    if (effectiveTrack !== currentTrack && latestVersion !== currentVersion) return true
    return false
  }

  const applyAutoUpdateChannel = (reason: 'startup' | 'settings' = 'startup') => {
    const track = getEffectiveUpdateTrack()
    const currentTrack = inferUpdateTrackFromVersion(appVersion)
    const baseUpdateChannel = track === 'stable' ? 'latest' : track
    const nextFeedUrl = getUpdaterFeedUrlByTrack(track)
    const nextUpdaterChannel =
      process.platform === 'win32' && process.arch === 'arm64'
        ? `${baseUpdateChannel}-arm64`
        : baseUpdateChannel
    if (
      (lastAppliedUpdaterChannel && lastAppliedUpdaterChannel !== nextUpdaterChannel) ||
      (lastAppliedUpdaterFeedUrl && lastAppliedUpdaterFeedUrl !== nextFeedUrl)
    ) {
      resetUpdaterProviderCache()
    }
    autoUpdater.allowPrerelease = track !== 'stable'
    autoUpdater.allowDowngrade = track !== currentTrack
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: nextFeedUrl,
      channel: nextUpdaterChannel
    })
    autoUpdater.channel = nextUpdaterChannel
    lastAppliedUpdaterChannel = nextUpdaterChannel
    lastAppliedUpdaterFeedUrl = nextFeedUrl
    void reason
  }

  const getDialogReleaseNotes = (rawReleaseNotes: unknown): string => {
    const track = getEffectiveUpdateTrack()
    if (track !== 'stable') {
      return '修复了一些已知问题'
    }
    return normalizeReleaseNotes(rawReleaseNotes)
  }

  return {
    applyAutoUpdateChannel,
    getEffectiveUpdateTrack,
    shouldOfferUpdateForTrack,
    getDialogReleaseNotes,
    getIsDownloadInProgress: () => isDownloadInProgress,
    setIsDownloadInProgress: (value: boolean) => { isDownloadInProgress = value },
    getDownloadProgressHandler: () => downloadProgressHandler,
    setDownloadProgressHandler: (handler: ((progress: any) => void) | null) => { downloadProgressHandler = handler },
    getDownloadedHandler: () => downloadedHandler,
    setDownloadedHandler: (handler: (() => void) | null) => { downloadedHandler = handler }
  }
}

export type AutoUpdateHelpers = ReturnType<typeof createAutoUpdateHelpers>
