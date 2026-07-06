export const escapeMarkdownText = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]<>#+\-.!|])/g, '\\$1')
}

export const escapeMarkdownLinkText = (value: unknown): string => {
  return escapeMarkdownText(value).replace(/\r?\n/g, ' ')
}

export const toMarkdownUrl = (value: string): string => {
  return encodeURI(value)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
}

export const buildMarkdownBlockquote = (value: string): string => {
  return value
    .split(/\r?\n/)
    .map(line => `> ${line ? escapeMarkdownText(line) : ''}`)
    .join('\n')
}
