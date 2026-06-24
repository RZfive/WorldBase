import type {
  ApiChatMessage,
  ChatContentPart,
  ChatMessage,
  MessageContent,
  MultiModalContentPart,
  ToolCall
} from '../types.js'

const CONTINUATION_USER_MESSAGE = 'Continue the current task from the existing context. Do not repeat completed steps.'

/**
 * Attach an Anthropic prompt-caching breakpoint to the (large, stable) system
 * prompt so long conversations reuse it instead of re-billing it every turn.
 *
 * Only applied for Anthropic / Claude routing — other providers leave the
 * messages untouched and rely on automatic prefix caching, which the
 * static-first system prompt layout already keeps byte-stable across turns.
 */
export function applyPromptCaching (messages: ChatMessage[], isAnthropicProvider: boolean): ChatMessage[] {
  if (!isAnthropicProvider) return messages

  let cached = false
  return messages.map((message): ChatMessage => {
    if (cached || message.role !== 'system' || typeof message.content !== 'string' || message.content === '') {
      return message
    }
    cached = true
    const content: ChatContentPart[] = [
      { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }
    ]
    return { ...message, content }
  })
}

export function normalizeMessageContent (message: ApiChatMessage): MessageContent {
  const multiModalContent = normalizeMultiModalContent(message.multi_mod_content)
  if (multiModalContent !== null) {
    return multiModalContent
  }

  if (Array.isArray(message.content)) {
    return message.content
  }

  return typeof message.content === 'string' ? message.content : ''
}

export function normalizeMultiModalContent (parts?: MultiModalContentPart[]): MessageContent | null {
  if (!Array.isArray(parts) || parts.length === 0) {
    return null
  }

  const normalizedParts: ChatContentPart[] = []
  let hasImage = false

  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      normalizedParts.push({
        type: 'text',
        text: part.text
      })
    }

    if (part.inline_data?.data) {
      hasImage = true
      const mimeType = part.inline_data.mime_type?.trim() || 'image/png'
      normalizedParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${part.inline_data.data}`
        }
      })
    }
  }

  if (normalizedParts.length === 0) {
    return ''
  }

  if (!hasImage && normalizedParts.every(part => part.type === 'text')) {
    return normalizedParts
      .map(part => part.type === 'text' ? part.text : '')
      .join('')
  }

  return normalizedParts
}

export function normalizeAssistantMessage (message: ApiChatMessage): ChatMessage {
  return {
    role: message.role || 'assistant',
    content: normalizeMessageContent(message),
    tool_calls: normalizeToolCalls(message.tool_calls),
    tool_call_id: message.tool_call_id,
    reasoning_content: message.reasoning_content
  }
}

export function normalizeToolCalls (toolCalls?: ToolCall[]): ToolCall[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined
  }

  return toolCalls.map(toolCall => ({
    id: toolCall.id || '',
    type: 'function',
    function: {
      name: toolCall.function?.name || '',
      arguments: toolCall.function?.arguments || ''
    }
  }))
}

export function normalizeOutgoingMessages (messages: ChatMessage[]): ChatMessage[] {
  const normalized = messages.map(message => {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message
    }

    return {
      ...message,
      tool_calls: normalizeToolCalls(message.tool_calls)
    }
  })

  return ensureUserMessage(sanitizeToolMessageSequence(normalized))
}

function sanitizeToolMessageSequence (messages: ChatMessage[]): ChatMessage[] {
  const sanitized: ChatMessage[] = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]

    if (message.role === 'tool') {
      continue
    }

    if (message.role !== 'assistant' || !message.tool_calls || message.tool_calls.length === 0) {
      sanitized.push(message)
      continue
    }

    const normalizedToolCalls = normalizeToolCalls(message.tool_calls)
    if (!normalizedToolCalls || normalizedToolCalls.length === 0) {
      sanitized.push({
        ...message,
        tool_calls: undefined
      })
      continue
    }

    const expectedToolCallIds = new Set(normalizedToolCalls.map(toolCall => toolCall.id.trim()).filter(Boolean))
    if (expectedToolCallIds.size !== normalizedToolCalls.length) {
      continue
    }

    const toolMessages: ChatMessage[] = []
    let nextIndex = index + 1
    while (nextIndex < messages.length && messages[nextIndex].role === 'tool') {
      toolMessages.push(messages[nextIndex])
      nextIndex++
    }

    const matchedToolCallIds = new Set<string>()
    let hasInvalidToolResponse = toolMessages.length === 0

    for (const toolMessage of toolMessages) {
      const toolCallId = toolMessage.tool_call_id?.trim()
      if (!toolCallId || !expectedToolCallIds.has(toolCallId) || matchedToolCallIds.has(toolCallId)) {
        hasInvalidToolResponse = true
        break
      }

      matchedToolCallIds.add(toolCallId)
    }

    if (!hasInvalidToolResponse && matchedToolCallIds.size === expectedToolCallIds.size) {
      sanitized.push({
        ...message,
        tool_calls: normalizedToolCalls
      })
      sanitized.push(...toolMessages)
    }

    index = nextIndex - 1
  }

  return sanitized
}

export function ensureUserMessage (messages: ChatMessage[]): ChatMessage[] {
  if (messages.some(message => message.role === 'user')) {
    return messages
  }

  return [
    ...messages,
    {
      role: 'user',
      content: CONTINUATION_USER_MESSAGE
    }
  ]
}

export { CONTINUATION_USER_MESSAGE }
