import { normalizeAbortReason } from '../../../abort-utils.js'
import { buildRequestBody } from '../runtime/request-body.js'
import {
  fetchWithRetry,
  normalizeRequestError,
  readStreamChunkWithIdleTimeout,
  STREAM_IDLE_TIMEOUT_MS
} from '../runtime/http.js'
import { normalizeAssistantMessage } from '../runtime/messages.js'
import { getChatCompletionUrl } from '../runtime/urls.js'
import type {
  ApiChatMessage,
  ChatCompletionStreamEvent,
  ChatMessage,
  OpenAIProviderRuntime,
  RequestOptions,
  StreamDelta,
  ToolCall,
  ToolDefinition,
  UsageCallback
} from '../types.js'

/**
 * Make a chat completion request with function calling support.
 */
export async function chatCompletion (
  runtime: OpenAIProviderRuntime,
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  abortSignal?: AbortSignal,
  options?: RequestOptions
): Promise<ChatMessage> {
  const body = buildRequestBody(runtime, messages, tools, false)
  const chatCompletionUrl = getChatCompletionUrl(runtime.baseUrl)
  const callId = runtime.logger?.logProviderCallStart({
    stream: false,
    model: runtime.model,
    baseUrl: chatCompletionUrl,
    messages: body.messages,
    tools
  })

  try {
    const response = await fetchWithRetry(runtime, chatCompletionUrl, body, false, abortSignal, options)
    const data = await response.json() as { choices: Array<{ message: ApiChatMessage }>; usage?: Record<string, unknown> }
    const message = normalizeAssistantMessage(data.choices[0].message)
    if (data.usage && runtime.onUsage) {
      runtime.onUsage(data.usage as Parameters<UsageCallback>[0])
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
 * Streaming chat completion. Yields content tokens as they arrive.
 * When tool_calls are present in the stream, they are accumulated
 * and returned as a complete ChatMessage at the end.
 * Supports reasoning_content (thinking) from compatible models.
 */
export async function * chatCompletionStream (
  runtime: OpenAIProviderRuntime,
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  abortSignal?: AbortSignal
): AsyncGenerator<ChatCompletionStreamEvent> {
  const body = buildRequestBody(runtime, messages, tools, true)
  const chatCompletionUrl = getChatCompletionUrl(runtime.baseUrl)
  const callId = runtime.logger?.logProviderCallStart({
    stream: true,
    model: runtime.model,
    baseUrl: chatCompletionUrl,
    messages: body.messages,
    tools
  })

  try {
    const response = await fetchWithRetry(runtime, chatCompletionUrl, body, true, abortSignal)

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    const fullContentChunks: string[] = []
    const fullReasoningChunks: string[] = []
    const toolCallsMap = new Map<number, ToolCall>()

    try {
      while (true) {
        if (abortSignal?.aborted) {
          throw normalizeAbortReason(abortSignal.reason)
        }
        const { done, value } = await readStreamChunkWithIdleTimeout(reader, STREAM_IDLE_TIMEOUT_MS)
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const jsonStr = trimmed.slice(6)
          if (jsonStr === '[DONE]') continue

          let parsed: { choices?: Array<{ delta: StreamDelta; finish_reason?: string | null }>; usage?: Record<string, unknown> }
          try {
            parsed = JSON.parse(jsonStr)
          } catch {
            continue
          }

          // Extract usage from the final stream chunk (OpenAI sends it when stream_options.include_usage is true).
          if (parsed.usage && runtime.onUsage) {
            runtime.onUsage(parsed.usage as Parameters<UsageCallback>[0])
          }

          const delta = parsed.choices?.[0]?.delta
          if (!delta) continue

          // Handle reasoning_content (thinking) from compatible models.
          if (delta.reasoning_content) {
            fullReasoningChunks.push(delta.reasoning_content)
            yield { type: 'thinking', content: delta.reasoning_content }
          }

          if (delta.content) {
            fullContentChunks.push(delta.content)
            yield { type: 'token', content: delta.content }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallsMap.has(tc.index)) {
                toolCallsMap.set(tc.index, {
                  id: tc.id || '',
                  type: 'function',
                  function: { name: '', arguments: '' }
                })
              }
              const existing = toolCallsMap.get(tc.index)!
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.function.name += tc.function.name
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
    const fullContent = fullContentChunks.join('')
    const fullReasoning = fullReasoningChunks.join('')
    const message: ChatMessage = {
      role: 'assistant',
      content: fullContent || ''
    }

    if (fullReasoning) {
      message.reasoning_content = fullReasoning
    }

    if (toolCallsMap.size > 0) {
      message.tool_calls = Array.from(toolCallsMap.values())
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
