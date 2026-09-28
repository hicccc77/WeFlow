import * as fs from 'fs'

function isCloneUnsupportedError(code?: string): boolean {
  return code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EXDEV'
}

function isHardlinkFallbackError(code?: string): boolean {
  return code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EINVAL' || code === 'ENOSYS' || code === 'ENOTSUP'
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

export async function ensureExportDir(dirPath: string, control?: { recordCreatedDir?: (path: string) => void }, dirCache?: Set<string>): Promise<void> {
  if (dirCache?.has(dirPath)) return
  const existed = await pathExists(dirPath)
  await fs.promises.mkdir(dirPath, { recursive: true })
  dirCache?.add(dirPath)
  if (!existed) {
    control?.recordCreatedDir?.(dirPath)
  }
}

export async function copyFileOptimized(sourcePath: string, destPath: string): Promise<{ success: boolean; code?: string }> {
  const cloneFlag = typeof fs.constants.COPYFILE_FICLONE === 'number' ? fs.constants.COPYFILE_FICLONE : 0
  try {
    if (cloneFlag) {
      await fs.promises.copyFile(sourcePath, destPath, cloneFlag)
    } else {
      await fs.promises.copyFile(sourcePath, destPath)
    }
    return { success: true }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    if (!isCloneUnsupportedError(code)) {
      return { success: false, code }
    }
  }

  try {
    await fs.promises.copyFile(sourcePath, destPath)
    return { success: true }
  } catch (e) {
    return { success: false, code: (e as NodeJS.ErrnoException | undefined)?.code }
  }
}

export async function hardlinkOrCopyFile(sourcePath: string, destPath: string): Promise<{ success: boolean; code?: string; linked?: boolean }> {
  try {
    await fs.promises.link(sourcePath, destPath)
    return { success: true, linked: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EEXIST') {
      return { success: true, linked: true }
    }
    if (!isHardlinkFallbackError(code)) {
      return { success: false, code }
    }
  }

  const copied = await copyFileOptimized(sourcePath, destPath)
  if (!copied.success) return copied
  return { success: true, linked: false }
}
