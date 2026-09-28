export function getAvatarFallback(name: string): string {
  if (!name) return '?'
  return [...name][0] || '?'
}
