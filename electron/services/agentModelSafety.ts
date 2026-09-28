import type {
  LanguageModelV2,
  LanguageModelV3,
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider'
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai'

const DELTA_PART_TYPES = new Set([
  'text-delta',
  'reasoning-delta',
  'tool-input-delta',
])

export function truncateStringToSchemaMax(
  value: string,
  schemaVariants: readonly Record<string, unknown>[],
): { value: string; changed: boolean } {
  const maxLength = schemaVariants
    .map((schema) => schema.maxLength)
    .find((candidate): candidate is number => (
      typeof candidate === 'number'
      && Number.isFinite(candidate)
      && candidate >= 0
    ))
  if (maxLength === undefined || value.length <= maxLength) {
    return { value, changed: false }
  }
  return { value: value.slice(0, Math.floor(maxLength)), changed: true }
}

export function normalizeAgentModelStreamPart(
  part: LanguageModelV4StreamPart,
): LanguageModelV4StreamPart | null {
  const candidate = part as LanguageModelV4StreamPart & { delta?: unknown }
  return DELTA_PART_TYPES.has(part.type) && typeof candidate.delta !== 'string'
    ? null
    : part
}

/**
 * 丢弃供应商偶发产生的无 delta 增量。空增量不承载内容，但 AI SDK 会在消费它时
 * 直接读取 `delta.length`，因此必须在进入 SDK 的文本流处理器前完成边界校验。
 */
export function withAgentModelStreamSafety(
  model: LanguageModelV2 | LanguageModelV3 | LanguageModelV4,
  onProviderEvent?: (type: string, data: Record<string, unknown>) => void,
): LanguageModelV4 {
  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v4',
    wrapStream: async ({ doStream }) => {
      const result = await doStream()
      return {
        ...result,
        stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            const normalized = normalizeAgentModelStreamPart(part)
            if (normalized) {
              controller.enqueue(normalized)
              return
            }
            try {
              onProviderEvent?.('provider_stream_invalid_delta', {
                partType: part.type,
                partId: String((part as { id?: unknown }).id || ''),
              })
            } catch {
              // 诊断回调不能反向中断模型流。
            }
          },
        })),
      }
    },
  }
  return wrapLanguageModel({ model, middleware })
}
