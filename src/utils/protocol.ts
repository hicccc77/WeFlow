/**
 * 将文件路径转换为 weflow:// 协议 URL
 */
export function toWeflowUrl(filePath: string): string {
  if (!filePath) return ''
  if (filePath.startsWith('weflow://')) return filePath
  if (filePath.startsWith('file://')) {
    filePath = filePath.substring('file://'.length)
  }
  const normalized = filePath.replace(/\\/g, '/')
  return encodeURI(`weflow://${normalized.startsWith('/') ? '' : '/'}${normalized}`).replace(/#/g, '%23')
}
