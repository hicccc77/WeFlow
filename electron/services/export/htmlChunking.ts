export const HTML_EXTERNAL_CHUNK_THRESHOLD = 20_000
export const HTML_DATA_CHUNK_SIZE = 500

export interface HtmlChunkDescriptor {
  /** Chunk index. */
  i: number
  /** Inclusive global message index. */
  s: number
  /** Exclusive global message index. */
  e: number
  /** Message count. */
  n: number
  /** Minimum timestamp in this chunk. */
  min: number
  /** Maximum timestamp in this chunk. */
  max: number
  /** Relative URL for an external chunk. */
  u?: string
}

export interface HtmlChunkManifest {
  v: 2
  total: number
  z: number
  external: boolean
  chunks: HtmlChunkDescriptor[]
}

export interface BuildHtmlChunkManifestOptions {
  external: boolean
  chunkSize?: number
  dataDirectoryUrl?: string
}

export function buildHtmlChunkManifest(
  timestamps: number[],
  options: BuildHtmlChunkManifestOptions
): HtmlChunkManifest {
  const configuredChunkSize = Math.max(1, Math.floor(options.chunkSize || HTML_DATA_CHUNK_SIZE))
  const chunkSize = options.external
    ? configuredChunkSize
    : Math.max(1, timestamps.length)
  const chunks: HtmlChunkDescriptor[] = []

  for (let start = 0, chunkIndex = 0; start < timestamps.length; start += chunkSize, chunkIndex++) {
    const end = Math.min(start + chunkSize, timestamps.length)
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY

    for (let index = start; index < end; index++) {
      const timestamp = Number(timestamps[index]) || 0
      if (timestamp < min) min = timestamp
      if (timestamp > max) max = timestamp
    }

    const fileName = `chunk-${String(chunkIndex).padStart(6, '0')}.js`
    chunks.push({
      i: chunkIndex,
      s: start,
      e: end,
      n: end - start,
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
      ...(options.external
        ? { u: `${String(options.dataDirectoryUrl || '').replace(/\/$/, '')}/${fileName}` }
        : {})
    })
  }

  return {
    v: 2,
    total: timestamps.length,
    z: chunkSize,
    external: options.external,
    chunks
  }
}

/**
 * Finds the first chunk whose timestamp range can contain the target.
 * Chunks are emitted in message order, so this is O(log n) for date jumps.
 */
export function findHtmlChunkIndexByTimestamp(
  chunks: HtmlChunkDescriptor[],
  targetTimestamp: number
): number {
  if (chunks.length === 0) return -1

  let low = 0
  let high = chunks.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (chunks[middle].max < targetTimestamp) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/** JSON that is safe both in an inline script and in an external data chunk. */
export function serializeHtmlScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
