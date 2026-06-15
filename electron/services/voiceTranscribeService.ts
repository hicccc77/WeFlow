import { app } from 'electron'
import { existsSync, mkdirSync, statSync, unlinkSync, createWriteStream, openSync, writeSync, closeSync } from 'fs'
import { join } from 'path'
import * as https from 'https'
import * as http from 'http'
import { ConfigService } from './config'

// Sherpa-onnx 类型定义
type OfflineRecognizer = any
type OfflineStream = any

type ModelInfo = {
  name: string
  files: {
    model: string
    tokens: string
  }
  sizeBytes: number
  sizeLabel: string
}

type DownloadProgress = {
  modelName: string
  downloadedBytes: number
  totalBytes?: number
  percent?: number
  speed?: number
}

const SENSEVOICE_MODEL: ModelInfo = {
  name: 'SenseVoiceSmall',
  files: {
    model: 'model.int8.onnx',
    tokens: 'tokens.txt'
  },
  sizeBytes: 245_000_000,
  sizeLabel: '245 MB'
}

const MODEL_DOWNLOAD_URLS = {
  model: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/model.int8.onnx',
  tokens: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/tokens.txt'
}

export class VoiceTranscribeService {
  private configService = new ConfigService()
  private downloadTasks = new Map<string, Promise<{ success: boolean; path?: string; error?: string }>>()
  private recognizer: OfflineRecognizer | null = null
  private isInitializing = false

  private buildTranscribeWorkerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    const platform = process.platform === 'win32' ? 'win' : process.platform
    const platformPkg = `sherpa-onnx-${platform}-${process.arch}`
    const candidates = [
      join(__dirname, '..', 'node_modules', platformPkg),
      join(__dirname, 'node_modules', platformPkg),
      join(process.cwd(), 'node_modules', platformPkg),
      process.resourcesPath ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', platformPkg) : ''
    ].filter((item): item is string => Boolean(item) && existsSync(item))

    if (process.platform === 'darwin') {
      const key = 'DYLD_LIBRARY_PATH'
      const existing = env[key] || ''
      const merged = [...candidates, ...existing.split(':').filter(Boolean)]
      env[key] = Array.from(new Set(merged)).join(':')
      if (candidates.length === 0) {
        console.warn(`[VoiceTranscribe] 未找到 ${platformPkg} 目录，可能导致语音引擎加载失败`)
      }
    } else if (process.platform === 'linux') {
      const key = 'LD_LIBRARY_PATH'
      const existing = env[key] || ''
      const merged = [...candidates, ...existing.split(':').filter(Boolean)]
      env[key] = Array.from(new Set(merged)).join(':')
      if (candidates.length === 0) {
        console.warn(`[VoiceTranscribe] 未找到 ${platformPkg} 目录，可能导致语音引擎加载失败`)
      }
    } else if (process.platform === 'win32') {
      // Windows: 把 sherpa-onnx 所在目录加到 PATH，否则 native module 找不到依赖
      const existing = env['PATH'] || ''
      const merged = [...candidates, ...existing.split(';').filter(Boolean)]
      env['PATH'] = Array.from(new Set(merged)).join(';')
      if (candidates.length === 0) {
        console.warn(`[VoiceTranscribe] 未找到 ${platformPkg} 目录，可能导致语音引擎加载失败`)
      }
    }

    return env
  }

  private resolveModelDir(): string {
    const configured = this.configService.get('whisperModelDir') as string | undefined
    if (configured) return configured
    return join(app.getPath('documents'), 'WeFlow', 'models', 'sensevoice')
  }

  private resolveModelPath(fileName: string): string {
    return join(this.resolveModelDir(), fileName)
  }

  /**
   * 检查模型状态
   */
  async getModelStatus(): Promise<{
    success: boolean
    exists?: boolean
    modelPath?: string
    tokensPath?: string
    sizeBytes?: number
    error?: string
  }> {
    try {
      const modelPath = this.resolveModelPath(SENSEVOICE_MODEL.files.model)
      const tokensPath = this.resolveModelPath(SENSEVOICE_MODEL.files.tokens)
      const modelExists = existsSync(modelPath)
      const tokensExists = existsSync(tokensPath)
      const exists = modelExists && tokensExists

      if (!exists) {
        return { success: true, exists: false, modelPath, tokensPath }
      }

      const modelSize = statSync(modelPath).size
      const tokensSize = statSync(tokensPath).size
      const totalSize = modelSize + tokensSize

      return {
        success: true,
        exists: true,
        modelPath,
        tokensPath,
        sizeBytes: totalSize
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 下载模型文件
   */
  async downloadModel(
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<{ success: boolean; modelPath?: string; tokensPath?: string; error?: string }> {
    const cacheKey = 'sensevoice'
    const pending = this.downloadTasks.get(cacheKey)
    if (pending) return pending

    const task = (async () => {
      try {
        const modelDir = this.resolveModelDir()
        if (!existsSync(modelDir)) {
          mkdirSync(modelDir, { recursive: true })
        }

        const modelPath = this.resolveModelPath(SENSEVOICE_MODEL.files.model)
        const tokensPath = this.resolveModelPath(SENSEVOICE_MODEL.files.tokens)

        // 初始进度
        onProgress?.({
          modelName: SENSEVOICE_MODEL.name,
          downloadedBytes: 0,
          totalBytes: SENSEVOICE_MODEL.sizeBytes,
          percent: 0
        })

        // 下载模型文件 (80% 权重)
        console.info('[VoiceTranscribe] 开始下载模型文件...')
        await this.downloadToFile(
          MODEL_DOWNLOAD_URLS.model,
          modelPath,
          'model',
          (downloaded, total, speed) => {
            const percent = total ? (downloaded / total) * 80 : 0
            onProgress?.({
              modelName: SENSEVOICE_MODEL.name,
              downloadedBytes: downloaded,
              totalBytes: SENSEVOICE_MODEL.sizeBytes,
              percent,
              speed
            })
          }
        )

        // 下载 tokens 文件 (20% 权重)
        console.info('[VoiceTranscribe] 开始下载 tokens 文件...')
        await this.downloadToFile(
          MODEL_DOWNLOAD_URLS.tokens,
          tokensPath,
          'tokens',
          (downloaded, total, speed) => {
            const modelSize = existsSync(modelPath) ? statSync(modelPath).size : 0
            const percent = total ? 80 + (downloaded / total) * 20 : 80
            onProgress?.({
              modelName: SENSEVOICE_MODEL.name,
              downloadedBytes: modelSize + downloaded,
              totalBytes: SENSEVOICE_MODEL.sizeBytes,
              percent,
              speed
            })
          }
        )

        console.info('[VoiceTranscribe] 模型下载完成')
        return { success: true, modelPath, tokensPath }
      } catch (error) {
        const modelPath = this.resolveModelPath(SENSEVOICE_MODEL.files.model)
        const tokensPath = this.resolveModelPath(SENSEVOICE_MODEL.files.tokens)
        try {
          if (existsSync(modelPath)) unlinkSync(modelPath)
          if (existsSync(tokensPath)) unlinkSync(tokensPath)
        } catch { }
        return { success: false, error: String(error) }
      } finally {
        this.downloadTasks.delete(cacheKey)
      }
    })()

    this.downloadTasks.set(cacheKey, task)
    return task
  }

  /**
   * 转写 WAV 音频数据
   */
  async transcribeWavBuffer(
    wavData: Buffer,
    onPartial?: (text: string) => void,
    languages?: string[]
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return new Promise((resolve) => {
      try {
        const modelPath = this.resolveModelPath(SENSEVOICE_MODEL.files.model)
        const tokensPath = this.resolveModelPath(SENSEVOICE_MODEL.files.tokens)

        if (!existsSync(modelPath) || !existsSync(tokensPath)) {
          resolve({ success: false, error: '模型文件不存在，请先下载模型' })
          return
        }

        let supportedLanguages = languages
        if (!supportedLanguages || supportedLanguages.length === 0) {
          supportedLanguages = this.configService.get('transcribeLanguages')
          if (!supportedLanguages || supportedLanguages.length === 0) {
            supportedLanguages = ['zh', 'yue']
          }
        }

        const { fork } = require('child_process')
        const workerPath = join(__dirname, 'transcribeWorker.js')

        const worker = fork(workerPath, [], {
          env: this.buildTranscribeWorkerEnv(),
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'advanced'
        })
        worker.send({
          modelPath,
          tokensPath,
          wavData,
          sampleRate: 16000,
          languages: supportedLanguages
        })

        let finalTranscript = ''

        worker.on('message', (msg: any) => {
          if (msg.type === 'partial') {
            onPartial?.(msg.text)
          } else if (msg.type === 'final') {
            finalTranscript = msg.text
            resolve({ success: true, transcript: finalTranscript })
            worker.disconnect()
            worker.kill()
          } else if (msg.type === 'error') {
            console.error('[VoiceTranscribe] Worker 错误:', msg.error)
            resolve({ success: false, error: msg.error })
            worker.disconnect()
            worker.kill()
          }
        })

        worker.on('error', (err: Error) => resolve({ success: false, error: String(err) }))
        worker.on('exit', (code: number | null, signal: string | null) => {
          if (code === null || signal === 'SIGSEGV') {

            console.error(`[VoiceTranscribe] Worker 异常崩溃，信号: ${signal}。可能是由于底层 C++ 运行库在当前系统上发生段错误。`);
            resolve({
              success: false,
              error: 'SEGFAULT_ERROR'
            });
            return;
          }

          if (code !== 0) {
            resolve({ success: false, error: `Worker exited with code ${code}` });
          }
        })

      } catch (error) {
        resolve({ success: false, error: String(error) })
      }
    })
  }

  /**
   * 下载文件 (支持多线程)
   */
  private async downloadToFile(
    url: string,
    targetPath: string,
    fileName: string,
    onProgress?: (downloaded: number, total?: number, speed?: number) => void
  ): Promise<void> {
    if (existsSync(targetPath)) {
      unlinkSync(targetPath)
    }

    console.info(`[VoiceTranscribe] 准备下载 ${fileName}: ${url}`)

    // 1. 探测支持情况
    let probeResult
    try {
      probeResult = await this.probeUrl(url)
    } catch (err) {
      console.warn(`[VoiceTranscribe] ${fileName} 探测失败，使用单线程`, err)
      return this.downloadSingleThread(url, targetPath, fileName, onProgress)
    }

    const { totalSize, acceptRanges, finalUrl } = probeResult

    // 如果文件太小 (< 2MB) 或者不支持 Range，使用单线程
    if (totalSize < 2 * 1024 * 1024 || !acceptRanges) {
      return this.downloadSingleThread(finalUrl, targetPath, fileName, onProgress)
    }

    console.info(`[VoiceTranscribe] ${fileName} 开始多线程下载 (4 线程), 大小: ${(totalSize / 1024 / 1024).toFixed(2)} MB`)

    const threadCount = 4
    const chunkSize = Math.ceil(totalSize / threadCount)
    const fd = openSync(targetPath, 'w')

    let downloadedTotal = 0
    let lastDownloaded = 0
    let lastTime = Date.now()
    let speed = 0

    const speedInterval = setInterval(() => {
      const now = Date.now()
      const duration = (now - lastTime) / 1000
      if (duration > 0) {
        speed = (downloadedTotal - lastDownloaded) / duration
        lastDownloaded = downloadedTotal
        lastTime = now
        onProgress?.(downloadedTotal, totalSize, speed)
      }
    }, 1000)

    try {
      const promises = []
      for (let i = 0; i < threadCount; i++) {
        const start = i * chunkSize
        const end = i === threadCount - 1 ? totalSize - 1 : (i + 1) * chunkSize - 1

        promises.push(this.downloadChunk(finalUrl, fd, start, end, (bytes) => {
          downloadedTotal += bytes
        }))
      }

      await Promise.all(promises)
      // Final progress update
      onProgress?.(totalSize, totalSize, 0)
      console.info(`[VoiceTranscribe] ${fileName} 多线程下载完成`)
    } catch (err) {
      console.error(`[VoiceTranscribe] ${fileName} 多线程下载失败:`, err)
      throw err
    } finally {
      clearInterval(speedInterval)
      closeSync(fd)
    }
  }

  private async probeUrl(url: string, remainingRedirects = 5): Promise<{ totalSize: number, acceptRanges: boolean, finalUrl: string }> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const options = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://modelscope.cn/',
          'Range': 'bytes=0-0'
        }
      }

      const req = protocol.get(url, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
          const location = res.headers.location
          if (location && remainingRedirects > 0) {
            const nextUrl = new URL(location, url).href
            this.probeUrl(nextUrl, remainingRedirects - 1).then(resolve).catch(reject)
            return
          }
        }

        if (res.statusCode !== 206 && res.statusCode !== 200) {
          reject(new Error(`Probe failed: HTTP ${res.statusCode}`))
          return
        }

        const contentRange = res.headers['content-range']
        let totalSize = 0
        if (contentRange) {
          const parts = contentRange.split('/')
          totalSize = parseInt(parts[parts.length - 1], 10)
        } else {
          totalSize = parseInt(res.headers['content-length'] || '0', 10)
        }

        const acceptRanges = res.headers['accept-ranges'] === 'bytes' || !!contentRange
        resolve({ totalSize, acceptRanges, finalUrl: url })
        res.destroy()
      })
      req.on('error', reject)
    })
  }

  private async downloadChunk(url: string, fd: number, start: number, end: number, onData: (bytes: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://modelscope.cn/',
          'Range': `bytes=${start}-${end}`
        }
      }

      const req = protocol.get(url, options, (res) => {
        if (res.statusCode !== 206) {
          reject(new Error(`Chunk download failed: HTTP ${res.statusCode}`))
          return
        }

        let currentOffset = start
        res.on('data', (chunk: Buffer) => {
          try {
            writeSync(fd, chunk, 0, chunk.length, currentOffset)
            currentOffset += chunk.length
            onData(chunk.length)
          } catch (err) {
            reject(err)
            res.destroy()
          }
        })

        res.on('end', () => resolve())
        res.on('error', reject)
      })
      req.on('error', reject)
    })
  }

  private async downloadSingleThread(url: string, targetPath: string, fileName: string, onProgress?: (downloaded: number, total?: number, speed?: number) => void, remainingRedirects = 5): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://modelscope.cn/'
        }
      }

      const request = protocol.get(url, options, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
          const location = response.headers.location
          if (location && remainingRedirects > 0) {
            const nextUrl = new URL(location, url).href
            this.downloadSingleThread(nextUrl, targetPath, fileName, onProgress, remainingRedirects - 1).then(resolve).catch(reject)
            return
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Fallback download failed: HTTP ${response.statusCode}`))
          return
        }

        const totalBytes = Number(response.headers['content-length'] || 0) || undefined
        let downloadedBytes = 0
        let lastDownloaded = 0
        let lastTime = Date.now()
        let speed = 0

        const speedInterval = setInterval(() => {
          const now = Date.now()
          const duration = (now - lastTime) / 1000
          if (duration > 0) {
            speed = (downloadedBytes - lastDownloaded) / duration
            lastDownloaded = downloadedBytes
            lastTime = now
            onProgress?.(downloadedBytes, totalBytes, speed)
          }
        }, 1000)

        const writer = createWriteStream(targetPath)
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length
        })

        writer.on('finish', () => {
          clearInterval(speedInterval)
          writer.close()
          resolve()
        })

        writer.on('error', (err) => {
          clearInterval(speedInterval)
          // 确保在错误情况下也关闭文件句柄
          writer.destroy()
          reject(err)
        })

        response.on('error', (err) => {
          clearInterval(speedInterval)
          // 确保在响应错误时也关闭文件句柄
          writer.destroy()
          reject(err)
        })

        response.pipe(writer)
      })
      request.on('error', reject)
    })
  }

  dispose() {
    if (this.recognizer) {
      this.recognizer = null
    }
  }
}

export const voiceTranscribeService = new VoiceTranscribeService()
