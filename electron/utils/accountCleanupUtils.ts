import { existsSync } from 'fs'
import { rm, readdir } from 'fs/promises'
import { join } from 'path'

export const normalizeAccountId = (value: string): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

export const buildAccountNameMatcher = (wxidCandidates: string[]) => {
  const loweredCandidates = wxidCandidates
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
  return (name: string): boolean => {
    const loweredName = String(name || '').trim().toLowerCase()
    if (!loweredName) return false
    return loweredCandidates.some((candidate) => (
      loweredName === candidate ||
      loweredName.startsWith(`${candidate}_`) ||
      loweredName.includes(candidate)
    ))
  }
}

export const removePathIfExists = async (
  targetPath: string,
  removedPaths: string[],
  warnings: string[]
): Promise<void> => {
  if (!targetPath || !existsSync(targetPath)) return
  try {
    await rm(targetPath, { recursive: true, force: true })
    removedPaths.push(targetPath)
  } catch (error) {
    warnings.push(`${targetPath}: ${String(error)}`)
  }
}

export const removeMatchedEntriesInDir = async (
  rootDir: string,
  shouldRemove: (name: string) => boolean,
  removedPaths: string[],
  warnings: string[]
): Promise<void> => {
  if (!rootDir || !existsSync(rootDir)) return
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!shouldRemove(entry.name)) continue
      const targetPath = join(rootDir, entry.name)
      await removePathIfExists(targetPath, removedPaths, warnings)
    }
  } catch (error) {
    warnings.push(`${rootDir}: ${String(error)}`)
  }
}
