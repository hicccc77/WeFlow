import { aiAnalysisLogger } from './logger'
import { getAiAnalysisSettings, upsertAiAnalysisTask } from './storage'
import type { AiAnalysisMediaType, AiAnalysisTaskRecord } from './types'

interface TimeSlice {
  start: number
  end: number
}

interface MessageLite {
  localType?: number
  parsedContent?: string
  content?: string
  rawContent?: string
}

interface StartTaskInput {
  taskId: string
  groupId: string
  groupName?: string
  rangeStart: number
  rangeEnd: number
  mediaTypes: AiAnalysisMediaType[]
  preprocessPromptOverride?: string
  mergePromptOverride?: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const formatErr = (error: unknown) => error instanceof Error ? error.message : String(error)

const createSlices = (start: number, end: number, approx = 15): TimeSlice[] => {
  const safeStart = Math.min(start, end)
  const safeEnd = Math.max(start, end)
  const total = Math.max(1, safeEnd - safeStart)
  const step = Math.max(1, Math.floor(total / approx))
  const slices: TimeSlice[] = []

  let cursor = safeStart
  while (cursor < safeEnd) {
    const next = Math.min(safeEnd, cursor + step)
    slices.push({ start: cursor, end: next })
    cursor = next
  }

  if (slices.length === 0) {
    slices.push({ start: safeStart, end: safeEnd })
  }

  return slices
}

const isImageMessage = (localType: number) => localType === 3

const isVideoMessage = (localType: number) => localType === 43

const resolveMediaType = (message: MessageLite): AiAnalysisMediaType => {
  const localType = Math.floor(Number(message.localType || 0))
  if (isImageMessage(localType)) return 'image'
  if (isVideoMessage(localType)) return 'video'
  return 'text'
}

const parseMessageTexts = (messages: MessageLite[]): string[] => {
  return messages
    .map((item) => String(item.parsedContent || item.content || item.rawContent || '').trim())
    .filter(Boolean)
}

const filterMessagesByMediaTypes = (messages: MessageLite[], mediaTypes: AiAnalysisMediaType[]) => {
  const selected = new Set(mediaTypes)
  return messages.filter((message) => selected.has(resolveMediaType(message)))
}

const loadGroupMessagesByRange = async (groupId: string, start: number, end: number) => {
  const limit = 500
  let offset = 0
  let hasMore = true
  const rows: MessageLite[] = []

  while (hasMore && rows.length < 20000) {
    const startSec = Math.floor(start / 1000)
    const endSec = Math.ceil(end / 1000)
    const result = await window.electronAPI.chat.getMessages(
      groupId,
      offset,
      limit,
      startSec,
      endSec,
      true
    )

    if (!result.success) {
      throw new Error(result.error || '读取聊天记录失败')
    }

    const list = result.messages || []
    rows.push(...list)
    hasMore = Boolean(result.hasMore)
    offset = Number(result.nextOffset || 0)
    if (list.length === 0) break
  }

  return rows
}

const updateTask = async (task: AiAnalysisTaskRecord) => {
  await upsertAiAnalysisTask({
    ...task,
    updatedAt: Date.now()
  })
}

const callDeepSeek = async (
  baseUrl: string,
  model: string,
  apiKey: string,
  prompt: string,
  content: string
) => {
  const requestAt = Date.now()
  if (!apiKey.trim()) {
    throw new Error('未配置 DeepSeek API Key')
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 120000)
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content }
      ],
      temperature: 0.2
    })
  })
  window.clearTimeout(timeout)

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`DeepSeek 请求失败: HTTP ${response.status} ${text.slice(0, 500)}`)
  }

  const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }
  const contentText = payload.choices?.[0]?.message?.content?.trim()
  if (!contentText) {
    throw new Error('DeepSeek 返回内容为空')
  }
  const durationMs = Date.now() - requestAt
  if (durationMs >= 0) {
    void durationMs
  }
  return contentText
}

export async function runAiAnalysisTask(input: StartTaskInput): Promise<AiAnalysisTaskRecord> {
  const taskStartAt = Date.now()
  const settings = await getAiAnalysisSettings()
  if (!settings.baseUrl.trim()) {
    throw new Error('未配置 DeepSeek Base URL')
  }
  if (!settings.model.trim()) {
    throw new Error('未配置 DeepSeek 模型名称')
  }
  const preprocessPrompt = (input.preprocessPromptOverride || settings.preprocessPrompt).trim()
  const mergePrompt = (input.mergePromptOverride || settings.mergePrompt).trim()
  if (!preprocessPrompt) {
    throw new Error('预处理提示词为空')
  }
  if (!mergePrompt) {
    throw new Error('合并分析提示词为空')
  }

  const task: AiAnalysisTaskRecord = {
    id: input.taskId,
    groupId: input.groupId,
    groupName: input.groupName,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    mediaTypes: input.mediaTypes,
    status: 'running',
    progress: {
      totalBatches: 0,
      completedBatches: 0
    },
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  await updateTask(task)
  await aiAnalysisLogger.info(task.id, 'task.start', '任务启动', {
    groupId: task.groupId,
    rangeStart: task.rangeStart,
    rangeEnd: task.rangeEnd,
    mediaTypes: task.mediaTypes
  }, 'TASK_START')

  const slices = createSlices(input.rangeStart, input.rangeEnd, 15)
  task.progress = {
    totalBatches: slices.length,
    completedBatches: 0
  }
  await updateTask(task)
  await aiAnalysisLogger.info(task.id, 'slice.generated', '时间切片生成完成', { slices })

  const chunkResults: string[] = []
  let totalFetchedMessages = 0
  let totalSentMessages = 0
  let totalSentTextChars = 0
  const sentByType: Record<string, number> = { text: 0, image: 0, video: 0 }

  for (let i = 0; i < slices.length; i += 1) {
    const slice = slices[i]
    task.progress = {
      totalBatches: slices.length,
      completedBatches: i,
      currentRange: slice
    }
    await updateTask(task)

    const batchStartAt = Date.now()
    let done = false
    let attempts = 0
    while (!done && attempts < 3) {
      attempts += 1
      try {
        const messages = await loadGroupMessagesByRange(input.groupId, slice.start, slice.end)
        totalFetchedMessages += messages.length
        const filteredMessages = filterMessagesByMediaTypes(messages, input.mediaTypes)
        const batchByType = filteredMessages.reduce<Record<string, number>>((acc, message) => {
          const mediaType = resolveMediaType(message)
          acc[mediaType] = (acc[mediaType] || 0) + 1
          return acc
        }, { text: 0, image: 0, video: 0 })
        sentByType.text += Number(batchByType.text || 0)
        sentByType.image += Number(batchByType.image || 0)
        sentByType.video += Number(batchByType.video || 0)
        await aiAnalysisLogger.info(task.id, 'batch.fetch', `第 ${i + 1} 批次消息拉取完成`, {
          range: slice,
          selectedMediaTypes: input.mediaTypes,
          messageCount: messages.length,
          filteredMessageCount: filteredMessages.length,
          byType: batchByType
        }, 'BATCH_FETCH_OK', Date.now() - batchStartAt)
        const texts = parseMessageTexts(filteredMessages)
        totalSentMessages += texts.length
        totalSentTextChars += texts.reduce((sum, text) => sum + text.length, 0)
        await aiAnalysisLogger.info(task.id, 'batch.payload', `第 ${i + 1} 批次发送统计`, {
          range: slice,
          selectedMediaTypes: input.mediaTypes,
          sentMessageCount: texts.length,
          sentTextChars: texts.reduce((sum, text) => sum + text.length, 0),
          byType: batchByType
        }, 'BATCH_PAYLOAD')
        const payloadText = JSON.stringify({
          batch: i + 1,
          totalBatches: slices.length,
          range: slice,
          mediaTypes: input.mediaTypes,
          messages: texts
        })

        const chunk = await callDeepSeek(
          settings.baseUrl,
          settings.model,
          settings.apiKey,
          preprocessPrompt,
          payloadText
        )

        chunkResults.push(chunk)
        await aiAnalysisLogger.info(task.id, 'batch.done', `已完成第 ${i + 1}/${slices.length} 批次`, {
          range: slice,
          attempts,
          status: attempts > 1 ? `重试${attempts - 1}次后成功` : '成功',
          chunkLength: chunk.length
        }, 'BATCH_DONE', Date.now() - batchStartAt)
        done = true
      } catch (error) {
        const errorMessage = formatErr(error)
        await aiAnalysisLogger.warn(task.id, 'batch.retry', `第 ${i + 1} 批次执行失败`, {
          range: slice,
          attempts,
          error: errorMessage
        }, 'BATCH_RETRY', Date.now() - batchStartAt)
        if (attempts >= 3) {
          await aiAnalysisLogger.error(task.id, 'batch.skip', `第 ${i + 1} 批次失败并跳过`, {
            range: slice,
            error: errorMessage
          }, 'BATCH_SKIP', Date.now() - batchStartAt)
          done = true
        } else {
          await sleep(1000)
        }
      }
    }

    task.progress = {
      totalBatches: slices.length,
      completedBatches: i + 1,
      currentRange: slice
    }
    await updateTask(task)
    await sleep(1000)
  }

  try {
    const mergeStartedAt = Date.now()
    const merged = await callDeepSeek(
      settings.baseUrl,
      settings.model,
      settings.apiKey,
      mergePrompt,
      JSON.stringify({
        taskId: task.id,
        groupId: task.groupId,
        totalBatches: slices.length,
        chunks: chunkResults
      })
    )

    task.status = 'succeeded'
    task.finalResultText = merged
    task.payloadStats = {
      selectedMediaTypes: [...input.mediaTypes],
      totalFetchedMessages,
      totalSentMessages,
      totalSentTextChars,
      byType: sentByType
    }

    const normalized = merged.trim()
    let parseError = ''
    if (!(normalized.startsWith('{') || normalized.startsWith('['))) {
      parseError = 'AI 输出不是 JSON 起始结构'
    } else {
      try {
        JSON.parse(normalized)
      } catch (error) {
        parseError = `AI JSON 解析失败: ${formatErr(error)}`
      }
    }

    if (parseError) {
      task.status = 'failed'
      task.errorMessage = parseError
      await updateTask(task)
      await aiAnalysisLogger.error(task.id, 'task.output_invalid', 'AI输出格式异常', {
        error: parseError,
        preview: normalized.slice(0, 800)
      }, 'AI_OUTPUT_INVALID', Date.now() - mergeStartedAt)
      return task
    }

    await updateTask(task)
    await aiAnalysisLogger.info(task.id, 'task.done', '任务完成', {
      mergedLength: merged.length,
      totalChunks: chunkResults.length,
      payloadStats: task.payloadStats
    }, 'TASK_DONE', Date.now() - taskStartAt)
    return task
  } catch (error) {
    const errorMessage = formatErr(error)
    task.status = 'failed'
    task.errorMessage = errorMessage
    await updateTask(task)
    await aiAnalysisLogger.error(task.id, 'task.failed', '任务失败', {
      error: errorMessage
    }, 'TASK_FAILED', Date.now() - taskStartAt)
    return task
  }
}

export async function rerunFailedBatch(params: {
  sourceTaskId: string
  failedRange: { start: number; end: number }
  groupId: string
  groupName?: string
  mediaTypes: AiAnalysisMediaType[]
}): Promise<AiAnalysisTaskRecord> {
  const taskId = `ai-rerun-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return runAiAnalysisTask({
    taskId,
    groupId: params.groupId,
    groupName: params.groupName,
    rangeStart: params.failedRange.start,
    rangeEnd: params.failedRange.end,
    mediaTypes: params.mediaTypes
  })
}

export function buildDefaultTimeRange(days: number): { start: number; end: number } {
  const end = Date.now()
  const normalizedDays = Math.max(1, Number(days || 30))
  const start = end - normalizedDays * 24 * 60 * 60 * 1000
  return { start, end }
}
