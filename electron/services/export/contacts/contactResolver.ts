import { ExportOptions, ExportDisplayProfile } from '../types'
import { resolveGroupNicknameByCandidates } from './groupNickname'

export function getPreferredDisplayName(
  accountId: string,
  nickname: string,
  remark: string,
  groupNickname: string,
  preference: 'group-nickname' | 'remark' | 'nickname' = 'remark'
): string {
  switch (preference) {
    case 'group-nickname':
      return groupNickname || remark || nickname || accountId
    case 'remark':
      return remark || nickname || accountId
    case 'nickname':
      return nickname || remark || accountId
    default:
      return nickname || remark || accountId
  }
}

export async function resolveExportDisplayProfile(
  accountId: string,
  preference: ExportOptions['displayNamePreference'],
  getContact: (username: string) => Promise<{ success: boolean; contact?: any; error?: string }>,
  groupNicknamesMap: Map<string, string>,
  fallbackDisplayName = '',
  extraGroupNicknameCandidates: Array<string | undefined | null> = []
): Promise<ExportDisplayProfile> {
  const resolvedAccountId = String(accountId || '').trim() || String(fallbackDisplayName || '').trim() || 'unknown'
  const contactResult = resolvedAccountId ? await getContact(resolvedAccountId) : { success: false as const }
  const contact = contactResult.success ? contactResult.contact : null
  const nickname = String(contact?.nickName || contact?.nick_name || fallbackDisplayName || resolvedAccountId)
  const remark = String(contact?.remark || '')
  const alias = String(contact?.alias || '')
  const groupNickname = resolveGroupNicknameByCandidates(
    groupNicknamesMap,
    [
      resolvedAccountId,
      contact?.username,
      contact?.userName,
      contact?.encryptUsername,
      contact?.encryptUserName,
      alias,
      ...extraGroupNicknameCandidates
    ]
  ) || ''
  const displayName = getPreferredDisplayName(
    resolvedAccountId,
    nickname,
    remark,
    groupNickname,
    preference || 'remark'
  )

  return {
    accountId: resolvedAccountId,
    nickname,
    remark,
    alias,
    groupNickname,
    displayName
  }
}
