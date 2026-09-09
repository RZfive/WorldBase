import { normalizeAbortReason } from '../../abort-utils.js'
import {
  buildAnthropicRequestBody,
  mapAnthropicUsage,
  normalizeAnthropicResponse
} from './convert.js'
import {
  fetchWithRetry,
  normalizeRequestError,
  readStreamChunkWithIdleTimeout,
  STREAM_IDLE_TIMEOUT_MS
} from '../openai-provider/runtime/http.js'
import { getAnthropicMessagesUrl } from '../openai-provider/runtime/urls.js'
import type {
  ChatCompletionStreamEvent,
  ChatContentPart,
  ChatMessage,
  RequestOptions,
  ToolDefinition
} from '../openai-provider/types.js'
import type {
  AnthropicMessagesResponse,
  AnthropicRuntime,
  AnthropicStreamEvent,
  AnthropicUsage
} from './types.js'

/**
 * Non-streaming Messages API call. Returns a normalized internal ChatMessage.
 */
export async function anthropicChatCompletion (
  runtime: AnthropicRuntime,
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  abortSignal?: AbortSignal,
  options?: RequestOptions
): Promise<ChatMessage> {
  const body = buildAnthropicRequestBody(runtime, messages, tools, false)
  const url = getAnthropicMessagesUrl(runtime.baseUrl)
  const callId = runtime.logger?.logProviderCallStart({
    stream: false,
    model: runtime.model,
    baseUrl: url,
    messages: body.messages,
    tools
  })

  try {
    const response = await fetchWithRetry(runtime, url, body, false, abortSignal, options, 'anthropic')
    const data = await readJsonWithAbort(response, abortSignal) as AnthropicMessagesResponse
    if (data.error) {
      throw new Error(`Anthropic API error: ${data.error.message || data.error.type || 'unknown error'}`)
    }
    const { message, usage } = normalizeAnthropicResponse(data)
    if (usage && runtime.onUsage) {
      runtime.onUsage(usage)
    }
    if (callId) {
      runtime.logger?.logProviderCallSuccess(callId, { message, raw: data })
    }
    return message
  } catch (error) {
    if (callId) {
      runtime.logger?.logProviderCallFailure(callId, normalizeRequestError(error), { stream: false, model: runtime.model })
    }
    throw error
  }
}

/**
 * Streaming Messages API call. Parses Anthropic's SSE event stream
 * (message_start / content_block_* / message_delta / message_stop) and maps it
 * to the engine-wide ChatCompletionStreamEvent shape: text_delta -> token,
 * thinking_delta -> thinking, input_json_delta -> accumulated tool_calls.
 */
export async function * anthropicChatCompletionStream (
  runtime: AnthropicRuntime,
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  abortSignal?: AbortSignal
): AsyncGenerator<ChatCompletionStreamEvent> {
  const body = buildAnthropicRequestBody(runtime, messages, tools, true)
  const url = getAnthropicMessagesUrl(runtime.baseUrl)
  const callId = runtime.logger?.logProviderCallStart({
    stream: true,
    model: runtime.model,
    baseUrl: url,
    messages: body.messages,
    tools
  })

  try {
    const response = await fetchWithRetry(runtime, url, body, true, abortSignal, undefined, 'anthropic')

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    const fullContentChunks: string[] = []
    const fullThinkingChunks: string[] = []
    const toolUses = new Map<number, { id: string; name: string; json: string }>()
    const contentBlocks = new Map<number, ChatContentPart>()
    const contentOrder: number[] = []
    const toolOrder: number[] = []
    let startUsage: AnthropicUsage | undefined
    let endUsage: AnthropicUsage | undefined

    try {
      while (true) {
        if (abortSignal?.aborted) {
          throw normalizeAbortReason(abortSignal.reason)
        }
        const { done, value } = await readStreamChunkWithIdleTimeout(reader, STREAM_IDLE_TIMEOUT_MS, abortSignal)
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const jsonStr = trimmed.slice(6)

          let parsed: AnthropicStreamEvent
          try {
            parsed = JSON.parse(jsonStr) as AnthropicStreamEvent
          } catch {
            continue
          }

          if (parsed.type === 'message_start') {
            startUsage = parsed.message?.usage
            continue
          }

          if (parsed.type === 'message_delta') {
            endUsage = parsed.usage
            continue
          }

          if (parsed.type === 'content_block_start') {
            const contentBlock = parsed.content_block
            if (contentBlock?.type === 'tool_use') {
              const index = parsed.index
              if (!toolUses.has(index)) toolOrder.push(index)
              toolUses.set(index, {
                id: contentBlock.id || '',
                name: contentBlock.name || '',
                json: ''
              })
            } else if (contentBlock?.type === 'text') {
              contentBlocks.set(parsed.index, { type: 'text', text: contentBlock.text || '' })
              contentOrder.push(parsed.index)
            } else if (contentBlock?.type === 'thinking') {
              contentBlocks.set(parsed.index, {
                type: 'thinking',
                thinking: contentBlock.thinking || '',
                signature: contentBlock.signature || ''
              })
              contentOrder.push(parsed.index)
            } else if (contentBlock?.type === 'redacted_thinking') {
              contentBlocks.set(parsed.index, { type: 'redacted_thinking', data: contentBlock.data || '' })
              contentOrder.push(parsed.index)
            }
            continue
          }

          if (parsed.type === 'content_block_delta') {
            const delta = parsed.delta
            if (!delta) continue
            if (delta.type === 'text_delta' && delta.text) {
              fullContentChunks.push(delta.text)
              const existing = contentBlocks.get(parsed.index)
              if (existing?.type === 'text') existing.text += delta.text
              yield { type: 'token', content: delta.text }
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              fullThinkingChunks.push(delta.thinking)
              const existing = contentBlocks.get(parsed.index)
              if (existing?.type === 'thinking') existing.thinking += delta.thinking
              yield { type: 'thinking', content: delta.thinking }
            } else if (delta.type === 'signature_delta' && delta.signature) {
              const existing = contentBlocks.get(parsed.index)
              if (existing?.type === 'thinking') existing.signature += delta.signature
            } else if (delta.type === 'input_json_delta' && delta.partial_json) {
              const entry = toolUses.get(parsed.index)
              if (entry) entry.json += delta.partial_json
            }
            continue
          }

          if (parsed.type === 'content_block_stop') {
            const entry = toolUses.get(parsed.index)
            if (entry && entry.json === '') entry.json = '{}'
            continue
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const usage = mapAnthropicUsage({
      input_tokens: startUsage?.input_tokens,
      output_tokens: endUsage?.output_tokens ?? startUsage?.output_tokens,
      cache_read_input_tokens: startUsage?.cache_read_input_tokens,
      cache_creation_input_tokens: startUsage?.cache_creation_input_tokens
    })
    if (usage && runtime.onUsage) {
      runtime.onUsage(usage)
    }

    const fullContent = fullContentChunks.join('')
    const fullThinking = fullThinkingChunks.join('')
    const replayableParts = contentOrder
      .map(index => contentBlocks.get(index))
      .filter((part): part is NonNullable<typeof part> => part !== undefined)
      .filter(part => part.type === 'text' ? part.text.length > 0 : true)
    const message: ChatMessage = {
      role: 'assistant',
      content: replayableParts.some(part => part.type === 'thinking' || part.type === 'redacted_thinking')
        ? replayableParts
        : fullContent || ''
    }

    if (fullThinking) {
      message.reasoning_content = fullThinking
    }

    if (toolOrder.length > 0) {
      message.tool_calls = toolOrder.map(index => {
        const entry = toolUses.get(index)!
        return {
          id: entry.id,
          type: 'function' as const,
          function: {
            name: entry.name,
            arguments: entry.json || '{}'
          }
        }
      })
      yield { type: 'tool_calls', message }
    }

    if (callId) {
      runtime.logger?.logProviderCallSuccess(callId, { message })
    }
    yield { type: 'done', message }
  } catch (err) {
    const normalized = abortSignal?.aborted
      ? normalizeAbortReason(abortSignal.reason)
      : normalizeRequestError(err)
    if (callId) {
      runtime.logger?.logProviderCallFailure(callId, normalized, { stream: true, model: runtime.model })
    }
    throw normalized
  }
}

async function readJsonWithAbort (response: Response, abortSignal?: AbortSignal): Promise<unknown> {
  if (!abortSignal) return response.json()
  if (abortSignal.aborted) {
    await response.body?.cancel().catch(() => {})
    throw normalizeAbortReason(abortSignal.reason)
  }
  let onAbort: (() => void) | null = null
  try {
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => {
        void response.body?.cancel().catch(() => {})
        reject(normalizeAbortReason(abortSignal.reason))
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([response.json(), abort])
  } finally {
    if (onAbort) abortSignal.removeEventListener('abort', onAbort)
  }
}
