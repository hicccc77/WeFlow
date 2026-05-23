export function cleanSystemMessageContent(content: string): string {
  if (!content) return '[系统消息]'

  const normalized = normalizeSystemMessageContent(content)
  const readable = extractReadableSystemMessageText(normalized)
  if (readable) return readable

  const revokeMatch = /<replacemsg><!\[CDATA\[(.*?)\]\]><\/replacemsg>/i.exec(normalized)
  if (revokeMatch) {
    return revokeMatch[1].trim()
  }

  const title = extractXmlValue(normalized, 'title')
  if (title) return title

  return stripSenderPrefix(normalized)
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/?[a-zA-Z0-9_:]+[^>]*>/g, '')
    .replace(/\d+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim() || '[系统消息]'
}

export function extractReadableSystemMessageText(content: string): string {
  if (!content) return ''

  const normalized = normalizeSystemMessageContent(content)
  const source = extractSysmsgBody(normalized)
  const template =
    extractXmlValue(source, 'plain') ||
    extractXmlValue(source, 'text') ||
    extractXmlValue(source, 'template') ||
    ''

  if (!template) return ''

  return normalizeReadableText(resolveSystemTemplate(template, source))
}

export function resolveSystemTemplate(template: string, source: string): string {
  const normalizedSource = normalizeSystemMessageContent(source)
  const normalizedTemplate = stripCdata(template)
  return normalizedTemplate.replace(/\$(\{)?([a-zA-Z0-9_:-]+)(\})?\$/g, (match, _open, varName) => {
    const value = resolveTemplateVariable(normalizedSource, String(varName || ''))
    return value || match
  }).replace(/\$\{([a-zA-Z0-9_:-]+)\}/g, (match, varName) => {
    const value = resolveTemplateVariable(normalizedSource, String(varName || ''))
    return value || match
  })
}

function resolveTemplateVariable(source: string, varName: string): string {
  if (!varName) return ''

  const linkValue = resolveLinkVariable(source, varName)
  if (linkValue) return linkValue

  const directValue = extractXmlValue(source, varName)
  if (directValue) return directValue

  return ''
}

function resolveLinkVariable(source: string, varName: string): string {
  const escapedName = escapeRegExp(varName)
  const linkRegex = new RegExp(`<link\\b(?=[^>]*\\bname\\s*=\\s*["']${escapedName}["'])[^>]*>([\\s\\S]*?)<\\/link>`, 'i')
  const match = linkRegex.exec(source)
  if (!match) return ''

  const body = match[1] || ''
  const names = collectMemberNames(body)
  if (names.length > 0) return names.join('、')

  return (
    extractXmlValue(body, 'nickname') ||
    extractXmlValue(body, 'displayname') ||
    extractXmlValue(body, 'displayName') ||
    extractXmlValue(body, 'plain') ||
    extractXmlValue(body, 'username') ||
    ''
  )
}

function collectMemberNames(body: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    const name = normalizeReadableText(value)
    if (!name || seen.has(name)) return
    seen.add(name)
    names.push(name)
  }

  for (const memberMatch of body.matchAll(/<member\b[^>]*>([\s\S]*?)<\/member>/gi)) {
    const member = memberMatch[0] || memberMatch[1] || ''
    add(extractXmlValue(member, 'nickname'))
    add(extractXmlValue(member, 'displayname'))
    add(extractXmlValue(member, 'displayName'))
    if (names.length === 0) add(extractXmlValue(member, 'username'))
  }

  for (const attrMatch of body.matchAll(/\b(?:nickname|displayname|displayName)\s*=\s*["']([^"']+)["']/gi)) {
    add(attrMatch[1] || '')
  }

  return names
}

function extractSysmsgBody(content: string): string {
  const sysmsgMatch = /<sysmsg\b[^>]*>([\s\S]*?)<\/sysmsg>/i.exec(stripSenderPrefix(content))
  return sysmsgMatch?.[1] || content
}

function extractXmlValue(xml: string, tagName: string): string {
  if (!xml || !tagName) return ''
  const regex = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, 'i')
  const match = regex.exec(xml)
  if (!match) return ''
  return stripCdata(match[1]).trim()
}

function stripCdata(value: string): string {
  return decodeHtmlEntities(String(value || ''))
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
}

function normalizeReadableText(value: string): string {
  return stripSenderPrefix(stripCdata(value))
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/?[a-zA-Z0-9_:]+[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeSystemMessageContent(content: string): string {
  return decodeHtmlEntities(String(content || ''))
    .replace(/<\?xml[^?]*\?>/gi, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
}

function stripSenderPrefix(content: string): string {
  return String(content || '').replace(/^[\s]*([a-zA-Z0-9_@-]+):(?!\/\/)(?:\s*(?:\r?\n|<br\s*\/?>)\s*|\s*)/i, '')
}

function decodeHtmlEntities(content: string): string {
  return content
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
