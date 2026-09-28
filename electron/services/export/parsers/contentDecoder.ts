export function looksLikeHex(s: string): boolean {
  if (s.length % 2 !== 0) return false
  return /^[0-9a-fA-F]+$/.test(s)
}

export function looksLikeBase64(s: string): boolean {
  if (s.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}

export function decodeBinaryContent(data: Buffer): string {
  if (data.length === 0) return ''
  try {
    if (data.length >= 4) {
      const magic = data.readUInt32LE(0)
      if (magic === 0xFD2FB528) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fzstd = require('fzstd')
        const decompressed = fzstd.decompress(data)
        return Buffer.from(decompressed).toString('utf-8')
      }
    }
    const decoded = data.toString('utf-8')
    const replacementCount = (decoded.match(/\uFFFD/g) || []).length
    if (replacementCount < decoded.length * 0.2) {
      return decoded.replace(/\uFFFD/g, '')
    }
    return data.toString('latin1')
  } catch {
    return ''
  }
}

export function decodeMaybeCompressed(raw: any): string {
  if (!raw) return ''
  if (typeof raw === 'string') {
    if (raw.length === 0) return ''
    if (/^[0-9]+$/.test(raw)) {
      return raw
    }
    // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
    if (raw.length > 16 && looksLikeHex(raw)) {
      const bytes = Buffer.from(raw, 'hex')
      if (bytes.length > 0) return decodeBinaryContent(bytes)
    }
    // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
    // 短字符串（如 "test", "home" 等）容易被误判为 base64
    if (raw.length > 16 && looksLikeBase64(raw)) {
      try {
        const bytes = Buffer.from(raw, 'base64')
        return decodeBinaryContent(bytes)
      } catch {
        return raw
      }
    }
    return raw
  }
  return ''
}

export function decodeMessageContent(messageContent: any, compressContent: any): string {
  let content = decodeMaybeCompressed(compressContent)
  if (!content || content.length === 0) {
    content = decodeMaybeCompressed(messageContent)
  }
  return content
}
