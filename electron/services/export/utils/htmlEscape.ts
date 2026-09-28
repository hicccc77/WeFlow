export function escapeHtml(value: string): string {
  if (!value) return ''
  return String(value).replace(/[&<>"']/g, c => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return c
    }
  })
}

export function escapeAttribute(value: string): string {
  if (!value) return ''
  return String(value).replace(/[&<>"'`]/g, c => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      case '`': return '&#96;'
      default: return c
    }
  })
}

export function renderMultilineText(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br />')
}

export function decodeHtmlEntities(value: string): string {
  if (!value) return ''
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, '`')
}
