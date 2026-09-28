import { parentPort, workerData } from 'worker_threads'
import { existsSync } from 'fs'
import { join } from 'path'

interface WorkerParams {
    modelPath: string
    tokensPath: string
    wavData: Buffer | Uint8Array | { type: 'Buffer'; data: number[] }
    sampleRate: number
    languages?: string[]
}

function appendLibrarySearchPath(libDir: string): void {
    if (!existsSync(libDir)) return

    if (process.platform === 'darwin') {
        const current = process.env.DYLD_LIBRARY_PATH || ''
        const paths = current.split(':').filter(Boolean)
        if (!paths.includes(libDir)) {
            process.env.DYLD_LIBRARY_PATH = [libDir, ...paths].join(':')
        }
        return
    }

    if (process.platform === 'linux') {
        const current = process.env.LD_LIBRARY_PATH || ''
        const paths = current.split(':').filter(Boolean)
        if (!paths.includes(libDir)) {
            process.env.LD_LIBRARY_PATH = [libDir, ...paths].join(':')
        }
    }
}

function prepareSherpaRuntimeEnv(): void {
    const platform = process.platform === 'win32' ? 'win' : process.platform
    const platformPkg = `sherpa-onnx-${platform}-${process.arch}`
    const resourcesPath = (process as any).resourcesPath as string | undefined

    const candidates = [
        // Dev: /project/dist-electron -> /project/node_modules/...
        join(__dirname, '..', 'node_modules', platformPkg),
        // Fallback for alternate layouts
        join(__dirname, 'node_modules', platformPkg),
        join(process.cwd(), 'node_modules', platformPkg),
        // Packaged app: Resources/app.asar.unpacked/node_modules/...
        resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'node_modules', platformPkg) : ''
    ].filter(Boolean)

    for (const dir of candidates) {
        appendLibrarySearchPath(dir)
    }
}

// 语言标记映射
const LANGUAGE_TAGS: Record<string, string> = {
    'zh': '<|zh|>',
    'en': '<|en|>',
    'ja': '<|ja|>',
    'ko': '<|ko|>',
    'yue': '<|yue|>' // 粤语
}

// 技术标签（识别语言、语速、ITN等），需要从最终文本中移除
const TECH_TAGS = [
    '<|zh|>', '<|en|>', '<|ja|>', '<|ko|>', '<|yue|>',
    '<|nospeech|>', '<|speech|>',
    '<|itn|>', '<|wo_itn|>',
    '<|NORMAL|>'
]

// 情感与事件标签映射，转换为直观的 Emoji
const RICH_TAG_MAP: Record<string, string> = {
    '<|HAPPY|>': '😊',
    '<|SAD|>': '😔',
    '<|ANGRY|>': '😠',
    '<|NEUTRAL|>': '', // 中性情感不特别标记
    '<|FEARFUL|>': '😨',
    '<|DISGUSTED|>': '🤢',
    '<|SURPRISED|>': '😮',
    '<|BGM|>': '🎵',
    '<|Applause|>': '👏',
    '<|Laughter|>': '😂',
    '<|Cry|>': '😭',
    '<|Cough|>': ' (咳嗽) ',
    '<|Sneeze|>': ' (喷嚏) ',
}

/**
 * 富文本后处理：移除技术标签，转换识别出的情感和声音事件
 */
function richTranscribePostProcess(text: string): string {
    if (!text) return ''

    let processed = text

    // 1. 转换情感和事件标签
    for (const [tag, replacement] of Object.entries(RICH_TAG_MAP)) {
        // 使用正则全局替换，不区分大小写以防不同版本差异
        const escapedTag = tag.replace(/[|<>]/g, '\\$&')
        processed = processed.replace(new RegExp(escapedTag, 'gi'), replacement)
    }

    // 2. 移除所有剩余的技术标签
    for (const tag of TECH_TAGS) {
        const escapedTag = tag.replace(/[|<>]/g, '\\$&')
        processed = processed.replace(new RegExp(escapedTag, 'gi'), '')
    }

    // 3. 清理多余空格并返回
    return processed.replace(/\s+/g, ' ').trim()
}

// 检查识别结果是否在允许的语言列表中
function isLanguageAllowed(result: any, allowedLanguages: string[]): boolean {
    if (!result || !result.lang) {
        // 如果没有语言信息，默认允许（或从文本开头尝试提取）
        return true
    }

    // 如果没有指定语言或语言列表为空，默认允许中文和粤语
    if (!allowedLanguages || allowedLanguages.length === 0) {
        allowedLanguages = ['zh', 'yue']
    }

    const langTag = result.lang
    

    // 检查是否在允许的语言列表中
    for (const lang of allowedLanguages) {
        if (LANGUAGE_TAGS[lang] === langTag) {
            
            return true
        }
    }

    
    return false
}

async function run() {
    const isForkProcess = !parentPort
    const emit = (msg: any) => {
        if (parentPort) {
            parentPort.postMessage(msg)
            return
        }
        if (typeof process.send === 'function') {
            process.send(msg)
        }
    }

    const normalizeBuffer = (data: WorkerParams['wavData']): Buffer => {
        if (Buffer.isBuffer(data)) return data
        if (data instanceof Uint8Array) return Buffer.from(data)
        if (data && typeof data === 'object' && (data as any).type === 'Buffer' && Array.isArray((data as any).data)) {
            return Buffer.from((data as any).data)
        }
        return Buffer.alloc(0)
    }

    const readParams = async (): Promise<WorkerParams | null> => {
        if (parentPort) {
            return workerData as WorkerParams
        }

        return new Promise((resolve) => {
            let settled = false
            const finish = (value: WorkerParams | null) => {
                if (settled) return
                settled = true
                resolve(value)
            }
            process.once('message', (msg) => finish(msg as WorkerParams))
            process.once('disconnect', () => finish(null))
        })
    }

    try {
        prepareSherpaRuntimeEnv()
        const params = await readParams()
        if (!params) return

        // 动态加载以捕获可能的加载错误（如 C++ 运行库缺失等）
        let sherpa: any;
        try {
            sherpa = require('sherpa-onnx-node');
        } catch (requireError) {
            emit({ type: 'error', error: 'Failed to load speech engine: ' + String(requireError) });
            if (isForkProcess) process.exit(1)
            return;
        }

        const { modelPath, tokensPath, wavData: rawWavData, sampleRate, languages } = params
        const wavData = normalizeBuffer(rawWavData);
        // 确保有有效的语言列表，默认只允许中文
        let allowedLanguages = languages || ['zh']
        if (allowedLanguages.length === 0) {
            allowedLanguages = ['zh']
        }

        

        // 1. 初始化识别器 (SenseVoiceSmall)
        const recognizerConfig = {
            modelConfig: {
                senseVoice: {
                    model: modelPath,
                    useInverseTextNormalization: 1
                },
                tokens: tokensPath,
                numThreads: 2,
                debug: 0
            }
        }
        const recognizer = new sherpa.OfflineRecognizer(recognizerConfig)

        // 2. 处理音频数据 (全量识别)
        const pcmData = wavData.slice(44)
        const samples = new Float32Array(pcmData.length / 2)
        for (let i = 0; i < samples.length; i++) {
            samples[i] = pcmData.readInt16LE(i * 2) / 32768.0
        }

        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate, samples })
        recognizer.decode(stream)
        const result = recognizer.getResult(stream)

        

        // 3. 检查语言是否在白名单中
        if (isLanguageAllowed(result, allowedLanguages)) {
            const processedText = richTranscribePostProcess(result.text)
            
            emit({ type: 'final', text: processedText })
            if (isForkProcess) process.exit(0)
        } else {
            
            emit({ type: 'final', text: '' })
            if (isForkProcess) process.exit(0)
        }

    } catch (error) {
        emit({ type: 'error', error: String(error) })
        if (isForkProcess) process.exit(1)
    }
}

run();
