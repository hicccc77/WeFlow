import { ExportOptions, ExportDisplayProfile } from '../types'
import { resolveGroupNicknameByCandidates } from './groupNickname'

export function getPreferredDisplayName(
  wxid: string,
  nickname: string,
  remark: string,
  groupNickname: string,
  preference: 'group-nickname' | 'remark' | 'nickname' = 'remark'
): string {
  switch (preference) {
    case 'group-nickname':
      return groupNickname || remark || nickname || wxid
    case 'remark':
      return remark || nickname || wxid
    case 'nickname':
      return nickname || remark || wxid
    default:
      return nickname || remark || wxid
  }
}

export async function resolveExportDisplayProfile(
  wxid: string,
  preference: ExportOptions['displayNamePreference'],
  getContact: (username: string) => Promise<{ success: boolean; contact?: any; error?: string }>,
  groupNicknamesMap: Map<string, string>,
  fallbackDisplayName = '',
  extraGroupNicknameCandidates: Array<string | undefined | null> = []
): Promise<ExportDisplayProfile> {
  const resolvedWxid = String(wxid || '').trim() || String(fallbackDisplayName || '').trim() || 'unknown'
  const contactResult = resolvedWxid ? await getContact(resolvedWxid) : { success: false as const }
  const contact = contactResult.success ? contactResult.contact : null
  const nickname = String(contact?.nickName || contact?.nick_name || fallbackDisplayName || resolvedWxid)
  const remark = String(contact?.remark || '')
  const alias = String(contact?.alias || '')
  const groupNickname = resolveGroupNicknameByCandidates(
    groupNicknamesMap,
    [
      resolvedWxid,
      contact?.username,
      contact?.userName,
      contact?.encryptUsername,
      contact?.encryptUserName,
      alias,
      ...extraGroupNicknameCandidates
    ]
  ) || ''
  const displayName = getPreferredDisplayName(
    resolvedWxid,
    nickname,
    remark,
    groupNickname,
    preference || 'remark'
  )

  return {
    wxid: resolvedWxid,
    nickname,
    remark,
    alias,
    groupNickname,
    displayName
  }
}
