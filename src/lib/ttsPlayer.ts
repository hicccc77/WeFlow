/**
 * 全局 TTS 播放器 —— 朗读 AI 回复 / 聊天消息 / 角色语音回复共用的单例。
 * 优先走主进程在线流式合成（tts:stream），不可流式时回退完整合成（tts:speak）；
 * 普通朗读未启用/未配置时回退浏览器 speechSynthesis；分身绑定音色时不回退系统朗读。
 * 同一时刻只播一条：再次触发同 key 即停止，触发其他 key 则切换。
 */
import { useEffect, useState } from 'react'
import type { PersonaTtsVoiceBindingInfo, TtsConfig, TtsSpeakOptions, TtsStreamEvent } from '@/types/electron'

export type TtsSpeakingPhase = 'loading' | 'playing'

export interface TtsSpeakingState {
  key: string
  phase: TtsSpeakingPhase
}

type SpeakingListener = (speakingState: TtsSpeakingState | null) => void

export interface SpeakResult {
  ok: boolean
  /** true = 本次调用是"点了正在播的那条"，已停止播放（连播链路据此中断） */
  stopped?: boolean
  error?: string
}

export interface SpeakOptions {
  awaitEnd?: boolean
  config?: Partial<TtsConfig>
  instructions?: string
  personaVoice?: PersonaTtsVoiceBindingInfo | null
}

let currentAudio: HTMLAudioElement | null = null
let currentStreamPlayer: PcmStreamPlayer | null = null
let currentCancelStream: (() => void) | null = null
/** 当前播放的清理回调（停止/切换时调用，保证 awaitEnd 的 Promise 不悬挂） */
let currentOnStop: (() => void) | null = null
let speakingState: TtsSpeakingState | null = null
/** 自增请求序号：合成是异步的，回来时如果用户已切到别的内容就丢弃 */
let requestSeq = 0
const listeners = new Set<SpeakingListener>()

function setSpeaking(state: TtsSpeakingState | null): void {
  speakingState = state
  listeners.forEach((listener) => listener(state))
}

function stopAudio(): void {
  const onStop = currentOnStop
  const cancelStream = currentCancelStream
  currentOnStop = null
  currentCancelStream = null
  cancelStream?.()
  if (currentStreamPlayer) {
    currentStreamPlayer.stop()
    currentStreamPlayer = null
  }
  if (currentAudio) {
    currentAudio.onended = null
    currentAudio.onerror = null
    currentAudio.pause()
    currentAudio = null
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel()
  }
  onStop?.()
}

export function getSpeakingKey(): string | null {
  return speakingState?.key || null
}

export function getSpeakingState(): TtsSpeakingState | null {
  return speakingState
}

/** 停止当前朗读（任何来源）。 */
export function stopSpeaking(): void {
  requestSeq += 1
  stopAudio()
  setSpeaking(null)
}

function speakWithSystem(key: string, text: string, seq: number): { started: boolean; done: Promise<void> } {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return { started: false, done: Promise.resolve() }
  }
  if (seq !== requestSeq) return { started: true, done: Promise.resolve() }

  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  let finished = false
  const clear = () => {
    if (finished) return
    finished = true
    if (currentOnStop === clear) currentOnStop = null
    setSpeaking(speakingState?.key === key ? null : speakingState)
    resolveDone()
  }

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'
  utterance.onend = clear
  utterance.onerror = clear
  currentOnStop = clear
  window.speechSynthesis.speak(utterance)
  return { started: true, done }
}

type PcmStreamPlayer = {
  readonly done: Promise<void>
  enqueue: (audioBase64: string, sampleRate?: number, channels?: number) => void
  finish: () => Promise<void>
  stop: () => void
}

function makeStreamId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `tts-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function decodePcm16Base64(audioBase64: string): Int16Array {
  const binary = atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
}

function createPcmStreamPlayer(key: string, onFirstChunk: () => void, onDone: () => void): PcmStreamPlayer | null {
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextCtor) return null

  const ctx = new AudioContextCtor() as AudioContext
  const sources = new Set<AudioBufferSourceNode>()
  let nextTime = ctx.currentTime + 0.08
  let finished = false
  let stopped = false
  let started = false
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })

  const settle = () => {
    if (!finished || sources.size > 0) return
    try { void ctx.close() } catch { /* ignore */ }
    onDone()
    resolveDone()
  }

  return {
    done,
    enqueue(audioBase64: string, sampleRate = 24000, channels = 1) {
      if (stopped) return
      const pcm = decodePcm16Base64(audioBase64)
      if (pcm.length === 0) return
      const frames = Math.floor(pcm.length / channels)
      if (frames <= 0) return

      const audioBuffer = ctx.createBuffer(channels, frames, sampleRate)
      for (let channel = 0; channel < channels; channel += 1) {
        const data = audioBuffer.getChannelData(channel)
        for (let i = 0; i < frames; i += 1) {
          data[i] = pcm[i * channels + channel] / 32768
        }
      }

      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)
      source.onended = () => {
        sources.delete(source)
        settle()
      }
      sources.add(source)
      if (!started) {
        started = true
        onFirstChunk()
      }
      const startAt = Math.max(ctx.currentTime + 0.03, nextTime)
      source.start(startAt)
      nextTime = startAt + audioBuffer.duration
      void ctx.resume()
    },
    finish() {
      finished = true
      settle()
      return done
    },
    stop() {
      if (stopped) return
      stopped = true
      finished = true
      for (const source of Array.from(sources)) {
        try { source.stop() } catch { /* ignore */ }
      }
      sources.clear()
      try { void ctx.close() } catch { /* ignore */ }
      onDone()
      resolveDone()
    },
  }
}

function buildTtsSpeakOptions(options: SpeakOptions): TtsSpeakOptions | undefined {
  const instructions = String(options.instructions || '').trim()
  const config = {
    ...(options.config || {}),
    ...(instructions ? { instructions } : {}),
  }
  return Object.keys(config).length > 0 || options.personaVoice
    ? {
      config: Object.keys(config).length > 0 ? config : undefined,
      personaVoice: options.personaVoice || undefined,
    }
    : undefined
}

async function playAudioBase64(
  key: string,
  audioBase64: string,
  mimeType: string | undefined,
  seq: number,
  awaitEnd?: boolean,
): Promise<SpeakResult> {
  if (seq !== requestSeq) return { ok: true, stopped: true }

  const audio = new Audio(`data:${mimeType || 'audio/mpeg'};base64,${audioBase64}`)
  let resolveEnd: (() => void) | null = null
  const ended = awaitEnd ? new Promise<void>((resolve) => { resolveEnd = resolve }) : null
  let finished = false
  const clear = () => {
    if (finished) return
    finished = true
    if (currentAudio === audio) currentAudio = null
    if (currentOnStop === clear) currentOnStop = null
    setSpeaking(speakingState?.key === key ? null : speakingState)
    resolveEnd?.()
  }
  audio.onended = clear
  audio.onerror = clear
  currentAudio = audio
  currentOnStop = clear
  try {
    setSpeaking({ key, phase: 'playing' })
    await audio.play()
  } catch (e) {
    clear()
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (ended) {
    await ended
    if (seq !== requestSeq) return { ok: true, stopped: true }
  }
  return { ok: true }
}

async function speakWithOnlineStream(
  key: string,
  text: string,
  requestOptions: TtsSpeakOptions | undefined,
  seq: number,
  awaitEnd?: boolean,
): Promise<SpeakResult | null> {
  if (!window.electronAPI.tts.stream) return null
  if (!(window.AudioContext || (window as any).webkitAudioContext)) return null

  const streamId = makeStreamId()
  const streamState: {
    player: PcmStreamPlayer | null
    completeEvent: Pick<TtsStreamEvent, 'audioBase64' | 'mimeType'> | null
  } = {
    player: null,
    completeEvent: null,
  }
  let streamedChunks = 0
  let settled = false

  const cancel = () => {
    void window.electronAPI.tts.cancelStream?.(streamId)
  }
  const clearStream = () => {
    if (settled) return
    settled = true
    if (currentStreamPlayer === streamState.player) currentStreamPlayer = null
    if (currentCancelStream === cancel) currentCancelStream = null
    if (currentOnStop === clearStream) currentOnStop = null
    if (speakingState?.key === key) setSpeaking(null)
  }

  currentCancelStream = cancel
  currentOnStop = clearStream

  try {
    const result = await window.electronAPI.tts.stream(streamId, text, requestOptions, (event) => {
      if (seq !== requestSeq) return
      if (event.type === 'complete' && event.audioBase64) {
        streamState.completeEvent = { audioBase64: event.audioBase64, mimeType: event.mimeType }
        return
      }
      if (event.type !== 'chunk' || event.format !== 'pcm16' || !event.audioBase64) return
      if (!streamState.player) {
        streamState.player = createPcmStreamPlayer(
          key,
          () => setSpeaking({ key, phase: 'playing' }),
          clearStream,
        )
        if (!streamState.player) return
        currentStreamPlayer = streamState.player
      }
      streamedChunks += 1
      streamState.player.enqueue(event.audioBase64, event.sampleRate || 24000, event.channels || 1)
    })

    if (seq !== requestSeq) return { ok: true, stopped: true }
    if (streamedChunks > 0 && streamState.player) {
      const done = streamState.player.finish()
      if (awaitEnd) {
        await done
        if (seq !== requestSeq) return { ok: true, stopped: true }
      }
      return result.success ? { ok: true } : { ok: false, error: result.error || '流式朗读失败' }
    }

    const completeAudio = streamState.completeEvent?.audioBase64 || result.audioBase64
    if (result.success && completeAudio) {
      clearStream()
      return playAudioBase64(key, completeAudio, streamState.completeEvent?.mimeType || result.mimeType, seq, awaitEnd)
    }

    clearStream()
    return null
  } catch {
    if (seq !== requestSeq) return { ok: true, stopped: true }
    clearStream()
    return null
  }
}

/**
 * 朗读一段文本。key 用于标识朗读对象（消息 id 等）：
 * 同 key 再次调用 = 停止（stopped: true）；不同 key = 切换。
 * awaitEnd: true 时等到播放结束才 resolve（连播队列用）。
 */
export async function speakText(key: string, text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
  const content = String(text || '').trim()
  if (!content) return { ok: false, error: '朗读内容为空' }
  const hasPersonaVoice = Boolean(options.personaVoice)

  if (speakingState?.key === key) {
    stopSpeaking()
    return { ok: true, stopped: true }
  }

  requestSeq += 1
  const seq = requestSeq
  stopAudio()
  setSpeaking({ key, phase: 'loading' })

  const requestOptions = buildTtsSpeakOptions(options)
  const streamResult = await speakWithOnlineStream(key, content, requestOptions, seq, options.awaitEnd)
  if (streamResult) return streamResult
  if (seq === requestSeq) setSpeaking({ key, phase: 'loading' })

  let result: { success: boolean; audioBase64?: string; mimeType?: string; error?: string; errorCode?: string } | null = null
  try {
    result = await window.electronAPI.tts.speak(content, requestOptions)
  } catch (e) {
    result = { success: false, error: e instanceof Error ? e.message : String(e), errorCode: 'SYNTHESIS_FAILED' }
  }

  // 合成期间用户已切换/停止
  if (seq !== requestSeq) return { ok: true, stopped: true }

  if (result?.success && result.audioBase64) {
    return playAudioBase64(key, result.audioBase64, result.mimeType, seq, options.awaitEnd)
  }

  if (hasPersonaVoice) {
    setSpeaking(null)
    return {
      ok: false,
      error: result?.error || '分身音色合成失败，请检查 TTS 配置或音色样本',
    }
  }

  // 未配置在线 TTS：回退系统朗读；其他失败也尽量回退，保证“能读出声”
  const system = speakWithSystem(key, content, seq)
  if (system.started) {
    if (seq === requestSeq) setSpeaking({ key, phase: 'playing' })
    if (options.awaitEnd) {
      await system.done
      if (seq !== requestSeq) return { ok: true, stopped: true }
    }
    return { ok: true }
  }

  setSpeaking(null)
  return { ok: false, error: result?.error || '朗读失败' }
}

/** React hook：订阅当前朗读对象 key，并提供朗读/停止方法。 */
export function useTtsSpeaker(): {
  speakingKey: string | null
  speakingState: TtsSpeakingState | null
  speak: (key: string, text: string, options?: SpeakOptions) => Promise<SpeakResult>
  stop: () => void
} {
  const [state, setState] = useState<TtsSpeakingState | null>(getSpeakingState())
  useEffect(() => {
    const listener: SpeakingListener = (next) => setState(next)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  return { speakingKey: state?.key || null, speakingState: state, speak: speakText, stop: stopSpeaking }
}

