declare module 'whisper-node' {
  export type WhisperSegment = {
    start: string
    end: string
    speech: string
  }

  export type WhisperOptions = {
    modelName?: string
    modelPath?: string
    whisperOptions?: {
      language?: string
      gen_file_txt?: boolean
      gen_file_subtitle?: boolean
      gen_file_vtt?: boolean
      word_timestamps?: boolean
      timestamp_size?: number
    }
  }

  export default function whisper(filePath: string, options?: WhisperOptions): Promise<WhisperSegment[]>
}
