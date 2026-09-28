import { extractXmlValue, normalizeAppMessageContent } from './xmlExtractor'

export function buildGroupNicknameIdCandidates(values: Array<string | undefined | null>): string[] {
  const set = new Set<string>()
  for (const rawValue of values) {
    const raw = String(rawValue || '').trim()
    if (!raw) continue
    set.add(raw)
  }
  return Array.from(set)
}

function normalizeGroupNicknameIdentity(value: string): string {
  return String(value || '').trim().toLowerCase()
}

function normalizeGroupNickname(value: string): string {
  const trimmed = (value || '').trim()
  if (!trimmed) return ''
  const cleaned = trimmed.replace(/[\x00-\x1F\x7F]/g, '')
  if (!cleaned) return ''
  if (/^[,"'“”‘’，、]+$/.test(cleaned)) return ''
  return cleaned
}

export function resolveGroupNicknameByCandidates(groupNicknamesMap: Map<string, string>, candidates: Array<string | undefined | null>): string {
  const idCandidates = buildGroupNicknameIdCandidates(candidates)
  if (idCandidates.length === 0) return ''

  let resolved = ''
  for (const id of idCandidates) {
    const normalizedId = normalizeGroupNicknameIdentity(id)
    if (!normalizedId) continue
    const candidateNickname = normalizeGroupNickname(groupNicknamesMap.get(normalizedId) || '')
    if (!candidateNickname) continue
    if (!resolved) {
      resolved = candidateNickname
      continue
    }
    if (resolved !== candidateNickname) return ''
  }

  return resolved
}

export async function resolveTransferDesc(
  content: string,
  myAccountId: string,
  groupNicknamesMap: Map<string, string>,
  getContactName: (username: string) => Promise<string>
): Promise<string | null> {
  const normalizedContent = normalizeAppMessageContent(content || '')
  if (!normalizedContent) return null

  const xmlType = extractXmlValue(normalizedContent, 'type')
  if (xmlType && xmlType !== '2000') return null

  const payerUsername = extractXmlValue(normalizedContent, 'payer_username')
  const receiverUsername = extractXmlValue(normalizedContent, 'receiver_username')
  if (!payerUsername || !receiverUsername) return null

  const cleanedMyAccountId = myAccountId

  const resolveName = async (username: string): Promise<string> => {
    if (myAccountId && (username === myAccountId || username === cleanedMyAccountId)) {
      const groupNick = resolveGroupNicknameByCandidates(groupNicknamesMap, [username, myAccountId, cleanedMyAccountId])
      if (groupNick) return groupNick
      return '我'
    }
    const groupNick = resolveGroupNicknameByCandidates(groupNicknamesMap, [username])
    if (groupNick) return groupNick
    return getContactName(username)
  }

  const [payerName, receiverName] = await Promise.all([
    resolveName(payerUsername),
    resolveName(receiverUsername)
  ])

  return `${payerName} 转账给 ${receiverName}`
}

export function isSameAccountId(lhs?: string, rhs?: string): boolean {
  const left = new Set(buildGroupNicknameIdCandidates([lhs]).map((id) => id.toLowerCase()))
  if (left.size === 0) return false
  const right = buildGroupNicknameIdCandidates([rhs]).map((id) => id.toLowerCase())
  return right.some((id) => left.has(id))
}

export function getTransferPrefix(content: string, myAccountId?: string, senderAccountId?: string, isSend?: boolean): '[转账]' | '[转账收款]' {
  const normalizedContent = normalizeAppMessageContent(content || '')
  if (!normalizedContent) return '[转账]'

  const paySubtype = extractXmlValue(normalizedContent, 'paysubtype')
  if (paySubtype === '3') return '[转账收款]'
  if (paySubtype === '1') return '[转账]'

  const payerUsername = extractXmlValue(normalizedContent, 'payer_username')
  const receiverUsername = extractXmlValue(normalizedContent, 'receiver_username')
  const senderIsPayer = senderAccountId ? isSameAccountId(senderAccountId, payerUsername) : false
  const senderIsReceiver = senderAccountId ? isSameAccountId(senderAccountId, receiverUsername) : false

  if (senderAccountId) {
    if (senderIsReceiver && !senderIsPayer) return '[转账]'
    if (senderIsPayer && !senderIsReceiver) return '[转账收款]'
  }

  if (myAccountId) {
    if (isSameAccountId(myAccountId, receiverUsername)) return '[转账]'
    if (isSameAccountId(myAccountId, payerUsername)) return '[转账收款]'
  }

  return '[转账]'
}

export function isTransferExportContent(content: string): boolean {
  return content.startsWith('[转账]') || content.startsWith('[转账收款]')
}

export function appendTransferDesc(content: string, transferDesc: string): string {
  const prefix = content.startsWith('[转账收款]') ? '[转账收款]' : '[转账]'
  return content.replace(prefix, `${prefix} (${transferDesc})`)
}

export function extractAmountFromText(text: string): string | null {
  if (!text) return null
  const match = /([¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(text)
  return match ? match[1].replace(/\s+/g, '') : null
}
