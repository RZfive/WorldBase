import { t } from '../../../../i18n/main-i18n.js'
import { normalizeOutgoingMessages } from '../runtime/messages.js'
import type {
  ChatContentPart,
  ChatMessage,
  ResponsesApiResponse,
  ResponsesBody,
  ResponsesContentImagePart,
  ResponsesContentTextPart,
  ResponsesInputMessage,
  ResponsesOutputImagePart,
  ResponsesOutputMessage,
  ResponsesOutputTextPart
} from '../types.js'

export function buildResponsesInput (messages: ChatMessage[], supportsImageEditing: boolean): ResponsesInputMessage[] {
  const normalizedMessages = normalizeOutgoingMessages(messages)
  if (!supportsImageEditing) {
    const hasImageInput = normalizedMessages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && Boolean(part.image_url?.url)))
    if (hasImageInput) {
      throw new Error(t('mainDialog.providerImageEditingDisabled'))
    }
  }

  const responseMessages = normalizedMessages.map((message) => {
    const parts: Array<ResponsesContentTextPart | ResponsesContentImagePart> = []

    if (typeof message.content === 'string') {
      if (message.content) {
        parts.push({ type: 'input_text', text: message.content })
      }
    } else {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          parts.push({ type: 'input_text', text: part.text })
        } else if (part.type === 'image_url' && part.image_url?.url && supportsImageEditing) {
          parts.push({ type: 'input_image', image_url: part.image_url.url })
        }
      }
    }

    return {
      role: message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
      content: parts
    }
  }).filter(message => message.content.length > 0)

  if (responseMessages.length > 0) {
    return responseMessages
  }

  return [{
    role: 'user',
    content: [{ type: 'input_text', text: 'Continue the current task from the existing context. Do not repeat completed steps.' }]
  }]
}

export function buildResponsesBody (model: string, messages: ChatMessage[], supportsImageEditing: boolean): ResponsesBody {
  const body: ResponsesBody = {
    model,
    input: buildResponsesInput(messages, supportsImageEditing),
    stream: false
  }

  body.tools = [{ type: 'image_generation' }]
  return body
}

export function resolveResponseImageUrl (part: ResponsesOutputImagePart): string | null {
  if (typeof part.image_url === 'string' && part.image_url) {
    return part.image_url
  }

  if (part.image_url && typeof part.image_url === 'object' && typeof part.image_url.url === 'string' && part.image_url.url) {
    return part.image_url.url
  }

  const base64 = typeof part.result === 'string' && part.result
    ? part.result
    : (typeof part.b64_json === 'string' ? part.b64_json : '')
  if (!base64) {
    return null
  }

  const mimeType = part.mime_type?.trim() || 'image/png'
  return `data:${mimeType};base64,${base64}`
}

export function normalizeResponsesMessage (data: ResponsesApiResponse): ChatMessage {
  const contentParts: ChatContentPart[] = []

  const pushText = (text?: string) => {
    if (typeof text !== 'string' || text.length === 0) return
    contentParts.push({ type: 'text', text })
  }

  const pushImage = (part: ResponsesOutputImagePart) => {
    const url = resolveResponseImageUrl(part)
    if (!url) return
    contentParts.push({
      type: 'image_url',
      image_url: { url }
    })
  }

  for (const outputItem of data.output || []) {
    if (outputItem && typeof outputItem === 'object' && Array.isArray((outputItem as ResponsesOutputMessage).content)) {
      for (const part of (outputItem as ResponsesOutputMessage).content || []) {
        if (part && typeof part === 'object' && 'text' in part) {
          pushText((part as ResponsesOutputTextPart).text)
        } else if (part && typeof part === 'object') {
          pushImage(part as ResponsesOutputImagePart)
        }
      }
      continue
    }

    if (outputItem && typeof outputItem === 'object' && 'text' in outputItem) {
      pushText((outputItem as ResponsesOutputTextPart).text)
    } else if (outputItem && typeof outputItem === 'object') {
      pushImage(outputItem as ResponsesOutputImagePart)
    }
  }

  if (contentParts.length === 0 && data.output_text) {
    return {
      role: 'assistant',
      content: data.output_text
    }
  }

  if (contentParts.length === 0) {
    return {
      role: 'assistant',
      content: ''
    }
  }

  if (contentParts.every(part => part.type === 'text')) {
    return {
      role: 'assistant',
      content: contentParts.map(part => part.type === 'text' ? part.text : '').join('')
    }
  }

  return {
    role: 'assistant',
    content: contentParts
  }
}

export function shouldRetryImageRequestWithoutTool (error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes('image_generation') ||
    message.includes('unknown tool') ||
    message.includes('invalid tool') ||
    message.includes('unsupported tool')
}

export function shouldFallbackToChatCompletions (error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes('missing_required_parameter') ||
    (message.includes('"input"') && message.includes('must be provided')) ||
    message.includes('previous_response_id') ||
    message.includes('conversation_id') ||
    message.includes('not found') && message.includes('/responses')
}
