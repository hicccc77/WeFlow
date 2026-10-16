/** Parse actual PCM timing rather than assuming 44 bytes and a fixed rate. */
export function parsePcmWav(wav: Buffer): { sampleRate: number; samples: Float32Array } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid PCM WAV container')
  const end = wav.readUInt32LE(4) + 8
  if (end !== wav.length) throw new Error('Invalid PCM WAV length')
  let rate = 0
  let pcm: Buffer | undefined
  for (let offset = 12; offset + 8 <= end;) {
    const kind = wav.toString('ascii', offset, offset + 4)
    const length = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    const next = start + length + (length % 2)
    if (next > end) throw new Error('Truncated PCM WAV chunk')
    if (kind === 'fmt ') {
      if (rate || length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt16LE(start + 14) !== 16) throw new Error('Only mono 16-bit PCM WAV is supported')
      rate = wav.readUInt32LE(start + 4)
      if (rate < 8000 || rate > 48000 || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt32LE(start + 8) !== rate * 2) throw new Error('Invalid PCM WAV timing')
    } else if (kind === 'data') {
      if (pcm || !length || length % 2) throw new Error('Invalid PCM WAV data')
      pcm = wav.subarray(start, start + length)
    }
    offset = next
    if (offset !== end && offset + 8 > end) throw new Error('Invalid PCM WAV trailing chunk')
  }
  if (!rate || !pcm) throw new Error('Missing PCM WAV format or data')
  const samples = new Float32Array(pcm.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768
  return { sampleRate: rate, samples }
}
