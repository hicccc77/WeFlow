type JsonRecord = Record<string, unknown>

export type OpenAICompatibleFetchEvent = {
  type: 'request_started' | 'response_headers' | 'response_first_byte' | 'request_finished' | 'request_failed' | 'request_timeout' | 'request_cancelled'
  data: Record<string, unknown>
}

export type OpenAICompatibleFetchOptions = {
  /** @deprecated Use idleTimeoutMs. Kept for existing callers. */
  timeoutMs?: number
  /** Maximum silence between headers or body chunks. Active streams reset it. */
  idleTimeoutMs?: number
  /** Absolute safety deadline even while a provider keeps the stream alive. */
  maxDurationMs?: number
  /** Test-only floor override; production defaults to 15 seconds. */
  minimumTimeoutMs?: number
  onEvent?: (event: OpenAICompatibleFetchEvent) => void
}

type ToolCallStreamState = {
  nextIndex: number
  idPrefix: string
  indexByKey: Map<string, number>
  idByIndex: Map<number, string>
}

let responseSequence = 0

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function createToolCallStreamState(): ToolCallStreamState {
  responseSequence += 1
  return {
    nextIndex: 0,
    idPrefix: `call_compat_${Date.now().toString(36)}_${responseSequence.toString(36)}`,
    indexByKey: new Map(),
    idByIndex: new Map(),
  }
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function jsonString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function textContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    if (!isRecord(value)) return undefined
    return textContent(value.text ?? value.content ?? value.value)
  }

  const parts = value.flatMap((part) => {
    const text = typeof part === 'string'
      ? part
      : isRecord(part)
        ? textContent(part.text ?? part.content ?? part.value)
        : undefined
    return text == null ? [] : [text]
  })
  return parts.length > 0 ? parts.join('') : undefined
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
  return undefined
}

function toolCallIndex(
  state: ToolCallStreamState,
  choiceKey: string,
  toolCall: JsonRecord,
  position: number,
  name: string | undefined,
): number {
  const originalIndex = numericValue(toolCall.index)
  const originalId = stringValue(toolCall.id, toolCall.tool_call_id, toolCall.call_id)
  const idKey = originalId ? `${choiceKey}:id:${originalId}` : ''
  const indexKey = originalIndex != null ? `${choiceKey}:index:${originalIndex}` : ''
  const identityKeys = [idKey, indexKey].filter(Boolean)
  const fallbackKeys = [
    name ? `${choiceKey}:name:${name}` : '',
    `${choiceKey}:position:${position}`,
  ].filter(Boolean)

  if (idKey) {
    const existingById = state.indexByKey.get(idKey)
    if (existingById != null) return existingById
    if (indexKey) {
      const existingByIndex = state.indexByKey.get(indexKey)
      const knownId = existingByIndex == null ? undefined : state.idByIndex.get(existingByIndex)
      if (existingByIndex != null && (!knownId || knownId.startsWith(state.idPrefix))) {
        state.indexByKey.set(idKey, existingByIndex)
        return existingByIndex
      }
    }
  } else if (indexKey) {
    const existingByIndex = state.indexByKey.get(indexKey)
    if (existingByIndex != null) return existingByIndex
  } else {
    for (const key of fallbackKeys) {
      const existing = state.indexByKey.get(key)
      if (existing != null) return existing
    }
  }

  const normalized = state.nextIndex
  state.nextIndex += 1
  for (const key of [...identityKeys, ...fallbackKeys]) {
    if (!state.indexByKey.has(key)) state.indexByKey.set(key, normalized)
  }
  return normalized
}

function normalizeToolCalls(
  state: ToolCallStreamState,
  choiceKey: string,
  delta: JsonRecord,
): JsonRecord[] | undefined {
  const legacyFunctionCall = delta.function_call ?? delta.functionCall
  const rawToolCalls = delta.tool_calls ?? delta.toolCalls
  const candidates = Array.isArray(rawToolCalls)
    ? rawToolCalls
    : isRecord(rawToolCalls)
      ? [rawToolCalls]
      : isRecord(legacyFunctionCall)
        ? [{ index: 0, function: legacyFunctionCall }]
        : undefined
  if (!candidates) return undefined

  return candidates.flatMap((candidate, position) => {
    if (!isRecord(candidate)) return []
    const rawFunction = isRecord(candidate.function)
      ? candidate.function
      : isRecord(candidate.functionCall)
        ? candidate.functionCall
        : candidate
    // Some OpenAI-compatible providers pad a valid function name with spaces.
    // Tool names are protocol identifiers, so trimming is deterministic
    // transport normalization rather than semantic repair.
    const name = stringValue(rawFunction.name, candidate.name, candidate.tool_name)?.trim() || undefined
    const index = toolCallIndex(state, choiceKey, candidate, position, name)
    const originalId = stringValue(candidate.id, candidate.tool_call_id, candidate.call_id)
    let id = originalId ?? state.idByIndex.get(index)
    if (originalId) state.idByIndex.set(index, originalId)
    if (!id) {
      id = `${state.idPrefix}_${index.toString(36)}`
      state.idByIndex.set(index, id)
    }

    const argumentsValue = rawFunction.arguments
      ?? rawFunction.args
      ?? rawFunction.parameters
      ?? rawFunction.input
      ?? candidate.arguments
      ?? candidate.input
    const normalized: JsonRecord = {
      ...candidate,
      index,
      id,
      type: 'function',
      function: {
        ...rawFunction,
        name: name ?? null,
        arguments: jsonString(argumentsValue),
      },
    }
    delete normalized.functionCall
    delete normalized.tool_call_id
    delete normalized.call_id
    return [normalized]
  })
}

function normalizeUsage(value: unknown): unknown {
  if (!isRecord(value)) return value
  const normalized = { ...value }
  const promptTokens = numericValue(normalized.prompt_tokens ?? normalized.input_tokens ?? normalized.inputTokens)
  const completionTokens = numericValue(normalized.completion_tokens ?? normalized.output_tokens ?? normalized.outputTokens)
  const cacheHitTokens = numericValue(
    normalized.prompt_cache_hit_tokens
    ?? normalized.prompt_cache_read_tokens
    ?? normalized.cache_read_input_tokens,
  )
  const cacheMissTokens = numericValue(
    normalized.prompt_cache_miss_tokens
    ?? normalized.cache_creation_input_tokens
    ?? normalized.cache_write_input_tokens,
  )
  if (promptTokens != null) normalized.prompt_tokens = promptTokens
  if (completionTokens != null) normalized.completion_tokens = completionTokens
  if (cacheHitTokens != null || cacheMissTokens != null) {
    const promptDetails = isRecord(normalized.prompt_tokens_details)
      ? { ...normalized.prompt_tokens_details }
      : {}
    if (cacheHitTokens != null) promptDetails.cached_tokens = cacheHitTokens
    if (cacheMissTokens != null) promptDetails.no_cache_tokens = cacheMissTokens
    normalized.prompt_tokens_details = promptDetails
  }
  if (normalized.total_tokens == null && promptTokens != null && completionTokens != null) {
    normalized.total_tokens = promptTokens + completionTokens
  }
  const numericFields = [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'cached_tokens',
    'reasoning_tokens',
    'accepted_prediction_tokens',
    'rejected_prediction_tokens',
  ]
  for (const field of numericFields) {
    const number = numericValue(normalized[field])
    if (number != null) normalized[field] = number
  }
  for (const field of ['prompt_tokens_details', 'completion_tokens_details']) {
    if (normalized[field] != null) normalized[field] = normalizeUsage(normalized[field])
  }
  return normalized
}

/**
 * Normalizes common deviations found in OpenAI-compatible gateways while
 * keeping the payload in the shape expected by @ai-sdk/openai-compatible.
 */
export function normalizeOpenAICompatibleChunk(
  value: unknown,
  state: ToolCallStreamState = createToolCallStreamState(),
): unknown {
  if (!isRecord(value)) return value
  const normalized: JsonRecord = { ...value }
  if (normalized.usage != null) normalized.usage = normalizeUsage(normalized.usage)

  const rawChoices = Array.isArray(value.choices)
    ? value.choices
    : isRecord(value.choice)
      ? [value.choice]
      : null
  if (!rawChoices) return normalized

  normalized.choices = rawChoices.map((rawChoice, position) => {
    if (!isRecord(rawChoice)) return rawChoice
    const choice = { ...rawChoice }
    const choiceKey = String(numericValue(choice.index) ?? position)
    const rawDelta = isRecord(choice.delta)
      ? choice.delta
      : isRecord(choice.message)
        ? choice.message
        : {}
    const delta: JsonRecord = { ...rawDelta }

    const content = textContent(delta.content)
    if (content != null) delta.content = content

    const reasoning = textContent(
      delta.reasoning_content
      ?? delta.reasoning
      ?? delta.reasoningContent
      ?? delta.thinking_content
      ?? delta.thinking
      ?? delta.thought
      ?? delta.analysis,
    )
    if (reasoning != null) delta.reasoning_content = reasoning

    const toolCalls = normalizeToolCalls(state, choiceKey, {
      ...delta,
      tool_calls: delta.tool_calls ?? delta.toolCalls ?? choice.tool_calls ?? choice.toolCalls,
      function_call: delta.function_call ?? delta.functionCall ?? choice.function_call ?? choice.functionCall,
    })
    if (toolCalls) delta.tool_calls = toolCalls
    delete delta.toolCalls
    delete delta.functionCall

    choice.delta = delta
    if (!isRecord(rawChoice.delta) && isRecord(rawChoice.message)) choice.message = { ...delta }
    const finishReason = stringValue(choice.finish_reason, choice.finishReason, choice.stop_reason, normalized.stop_reason)
    if (finishReason) choice.finish_reason = finishReason === 'function_call' || finishReason === 'tool_use'
      ? 'tool_calls'
      : finishReason
    return choice
  })
  return normalized
}

function normalizeSseBlock(block: string, state: ToolCallStreamState): string {
  const lines = block.split(/\r?\n/)
  const dataLines = lines.filter((line) => /^data\s*:/.test(line))
  if (dataLines.length === 0) return block
  const data = dataLines
    .map((line) => line.replace(/^data\s*:\s?/, ''))
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') return block

  try {
    const normalized = normalizeOpenAICompatibleChunk(JSON.parse(data), state)
    const nonDataLines = lines.filter((line) => !/^data\s*:/.test(line))
    return [...nonDataLines, `data: ${JSON.stringify(normalized)}`].filter(Boolean).join('\n')
  } catch {
    return block
  }
}

function createTextDecoderTransform(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder()
  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      const decoded = decoder.decode(chunk, { stream: true })
      if (decoded) controller.enqueue(decoded)
    },
    flush(controller) {
      const decoded = decoder.decode()
      if (decoded) controller.enqueue(decoded)
    },
  })
}

function normalizeSseStream(body: ReadableStream<Uint8Array>, state: ToolCallStreamState): ReadableStream<Uint8Array> {
  let buffer = ''
  return body
    .pipeThrough(createTextDecoderTransform())
    .pipeThrough(new TransformStream<string, string>({
      transform(chunk, controller) {
        buffer += chunk
        let separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
        while (separator?.index != null) {
          const end = separator.index
          controller.enqueue(`${normalizeSseBlock(buffer.slice(0, end), state)}${separator[0]}`)
          buffer = buffer.slice(end + separator[0].length)
          separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(normalizeSseBlock(buffer, state))
      },
    }))
    .pipeThrough(new TextEncoderStream())
}

function normalizeNdjsonStream(body: ReadableStream<Uint8Array>, state: ToolCallStreamState): ReadableStream<Uint8Array> {
  let buffer = ''
  const normalizeLine = (line: string): string => {
    const data = line.trim().replace(/^\u001e/, '')
    if (!data) return ''
    if (/^data\s*:/.test(data)) return `${normalizeSseBlock(data, state)}\n\n`
    if (data === '[DONE]') return 'data: [DONE]\n\n'
    try {
      return `data: ${JSON.stringify(normalizeOpenAICompatibleChunk(JSON.parse(data), state))}\n\n`
    } catch {
      return `${line}\n`
    }
  }

  return body
    .pipeThrough(createTextDecoderTransform())
    .pipeThrough(new TransformStream<string, string>({
      transform(chunk, controller) {
        buffer += chunk
        let end = buffer.search(/[\r\n]/)
        while (end >= 0) {
          const separatorLength = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1
          const output = normalizeLine(buffer.slice(0, end))
          if (output) controller.enqueue(output)
          buffer = buffer.slice(end + separatorLength)
          end = buffer.search(/[\r\n]/)
        }
      },
      flush(controller) {
        const output = normalizeLine(buffer)
        if (output) controller.enqueue(output)
      },
    }))
    .pipeThrough(new TextEncoderStream())
}

function rebuiltResponse(response: Response, body: BodyInit, contentType?: string): Response {
  const headers = new Headers(response.headers)
  if (contentType) headers.set('content-type', contentType)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function isChatCompletionsRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
  return /\/chat\/completions(?:[/?#]|$)/i.test(url)
}

function requestsStream(init?: RequestInit): boolean {
  if (typeof init?.body !== 'string') return false
  try {
    return JSON.parse(init.body)?.stream === true
  } catch {
    return false
  }
}

function requestUrl(value: RequestInfo | URL): string {
  try {
    const source = typeof value === 'string'
      ? value
      : value instanceof URL
        ? value.toString()
        : value.url
    const parsed = new URL(source)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return 'unknown'
  }
}

function requestMetadata(input: RequestInfo | URL, init?: RequestInit): Record<string, unknown> {
  const base: Record<string, unknown> = {
    url: requestUrl(input),
    method: String(init?.method || 'POST').toUpperCase(),
    bodyChars: typeof init?.body === 'string' ? init.body.length : undefined,
  }
  if (typeof init?.body !== 'string') return base
  try {
    const body = JSON.parse(init.body)
    const toolChoice = isRecord(body.tool_choice)
      ? isRecord(body.tool_choice.function)
        ? stringValue(body.tool_choice.function.name)
        : stringValue(body.tool_choice.name, body.tool_choice.type)
      : stringValue(body.tool_choice)
    return {
      ...base,
      model: stringValue(body.model),
      stream: body.stream === true,
      messageCount: Array.isArray(body.messages) ? body.messages.length : undefined,
      toolCount: Array.isArray(body.tools) ? body.tools.length : undefined,
      toolChoice,
    }
  } catch {
    return base
  }
}

function monitoredResponseBody(
  body: ReadableStream<Uint8Array>,
  onFirstByte: () => void,
  onActivity: () => void,
  onFinished: (error?: unknown, cancelled?: boolean) => void,
  timeoutError: () => Error | null,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let sawFirstByte = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          onFinished()
          controller.close()
          return
        }
        if (!sawFirstByte) {
          sawFirstByte = true
          onFirstByte()
        }
        onActivity()
        controller.enqueue(result.value)
      } catch (error) {
        const resolved = timeoutError() || error
        onFinished(resolved)
        controller.error(resolved)
      }
    },
    async cancel(reason) {
      onFinished(undefined, true)
      await reader.cancel(reason).catch(() => {})
    },
  })
}

/** Fetch middleware used only for the generic OpenAI-compatible protocol. */
export function createOpenAICompatibleFetch(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  options: OpenAICompatibleFetchOptions = {},
): typeof globalThis.fetch {
  return async (input, init) => {
    const beganAt = Date.now()
    const minimumTimeoutMs = Math.max(1, Math.floor(Number(options.minimumTimeoutMs) || 15_000))
    const idleTimeoutMs = Math.max(
      minimumTimeoutMs,
      Math.floor(Number(options.idleTimeoutMs ?? options.timeoutMs) || 120_000),
    )
    const maxDurationMs = Math.max(
      idleTimeoutMs,
      Math.floor(Number(options.maxDurationMs) || 480_000),
    )
    const requestId = `compat_${beganAt.toString(36)}_${(++responseSequence).toString(36)}`
    const metadata = requestMetadata(input, init)
    const emit = (type: OpenAICompatibleFetchEvent['type'], data: Record<string, unknown> = {}) => {
      try {
        options.onEvent?.({ type, data: { requestId, elapsedMs: Date.now() - beganAt, ...metadata, ...data } })
      } catch {
        // Provider diagnostics must never affect the request.
      }
    }
    const controller = new AbortController()
    const upstreamSignal = init?.signal
    let settled = false
    let timedOutError: Error | null = null
    let idleTimeout: ReturnType<typeof setTimeout> | undefined
    let deadlineTimeout: ReturnType<typeof setTimeout> | undefined
    let lastActivityAt = beganAt
    const cleanup = () => {
      if (idleTimeout) clearTimeout(idleTimeout)
      if (deadlineTimeout) clearTimeout(deadlineTimeout)
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort)
    }
    const settle = (
      type: 'request_finished' | 'request_failed' | 'request_timeout' | 'request_cancelled',
      data: Record<string, unknown> = {},
    ) => {
      if (settled) return
      settled = true
      cleanup()
      emit(type, data)
    }
    const onUpstreamAbort = () => {
      controller.abort(upstreamSignal?.reason)
      settle('request_cancelled', { phase: 'upstream-signal' })
    }
    const triggerTimeout = (timeoutKind: 'idle' | 'deadline') => {
      if (settled) return
      timedOutError = new Error(
        timeoutKind === 'idle'
          ? `AI provider stream made no progress for ${idleTimeoutMs} ms`
          : `AI provider request exceeded hard deadline ${maxDurationMs} ms`,
      )
      controller.abort(timedOutError)
      settle('request_timeout', {
        timeoutKind,
        idleTimeoutMs,
        maxDurationMs,
        lastActivityElapsedMs: lastActivityAt - beganAt,
      })
    }
    const markActivity = () => {
      if (settled) return
      lastActivityAt = Date.now()
      if (idleTimeout) clearTimeout(idleTimeout)
      idleTimeout = setTimeout(() => triggerTimeout('idle'), idleTimeoutMs)
    }
    if (upstreamSignal?.aborted) onUpstreamAbort()
    else upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true })
    markActivity()
    deadlineTimeout = setTimeout(() => triggerTimeout('deadline'), maxDurationMs)
    emit('request_started', { idleTimeoutMs, maxDurationMs })

    let response: Response
    try {
      response = await fetchImplementation(input, { ...init, signal: controller.signal })
    } catch (error) {
      const resolved = timedOutError || error
      if (!settled) settle('request_failed', {
        phase: 'headers',
        error: resolved instanceof Error ? resolved.message : String(resolved || 'unknown'),
      })
      throw resolved
    }
    emit('response_headers', {
      status: response.status,
      contentType: response.headers.get('content-type') || undefined,
    })
    markActivity()
    if (response.body) {
      const status = response.status
      response = rebuiltResponse(response, monitoredResponseBody(
        response.body,
        () => emit('response_first_byte'),
        markActivity,
        (error, cancelled) => {
          if (cancelled) settle('request_cancelled', { phase: 'body-consumer' })
          else if (error) settle('request_failed', {
            phase: 'body',
            error: error instanceof Error ? error.message : String(error || 'unknown'),
          })
          else settle('request_finished', { status })
        },
        () => timedOutError,
      ))
    } else {
      settle('request_finished', { status: response.status, emptyBody: true })
    }
    if (!response.ok || !response.body || !isChatCompletionsRequest(input)) return response

    const state = createToolCallStreamState()
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    const stream = requestsStream(init)

    if (/ndjson|jsonl|jsonlines|json-seq/.test(contentType)) {
      return rebuiltResponse(
        response,
        normalizeNdjsonStream(response.body, state),
        'text/event-stream; charset=utf-8',
      )
    }

    if (contentType.includes('application/json')) {
      const body = await response.text()
      try {
        const normalized = JSON.stringify(normalizeOpenAICompatibleChunk(JSON.parse(body), state))
        return stream
          ? rebuiltResponse(response, `data: ${normalized}\n\ndata: [DONE]\n\n`, 'text/event-stream; charset=utf-8')
          : rebuiltResponse(response, normalized, 'application/json; charset=utf-8')
      } catch {
        return stream
          ? rebuiltResponse(response, normalizeSseStream(
              new Blob([body]).stream() as ReadableStream<Uint8Array>,
              state,
            ), 'text/event-stream; charset=utf-8')
          : rebuiltResponse(response, body)
      }
    }

    if (stream || contentType.includes('text/event-stream')) {
      return rebuiltResponse(
        response,
        normalizeSseStream(response.body, state),
        'text/event-stream; charset=utf-8',
      )
    }
    return response
  }
}
