import { t } from '../../../../i18n/main-i18n.js'
import { buildRequestBody } from '../runtime/request-body.js'
import {
  fetchMultipartWithRetry,
  fetchWithRetry,
  IMAGE_REQUEST_TIMEOUT_MS,
  normalizeRequestError,
  validateOpenAIConfig
} from '../runtime/http.js'
import {
  dataUrlToBlob,
  extractImagesResult,
  isUnsupportedImageParameterError,
  normalizeImageQuality,
  shouldIncludeImageOutputFormat,
  shouldUseImageResponseFormat
} from './utils.js'
import { normalizeAssistantMessage, normalizeOutgoingMessages } from '../runtime/messages.js'
import { isDedicatedImageModel } from '../runtime/models.js'
import {
  buildResponsesBody,
  normalizeResponsesMessage,
  shouldFallbackToChatCompletions,
  shouldRetryImageRequestWithoutTool
} from './responses.js'
import {
  getChatCompletionUrl,
  getImagesEditsUrl,
  getImagesGenerationsUrl,
  getResponsesUrl
} from '../runtime/urls.js'
import type {
  ApiChatMessage,
  ChatContentPart,
  ChatContentTextPart,
  ChatMessage,
  EditImagesOptions,
  GenerateImagesOptions,
  ImageGenerationResult,
  ImagesGenerationsBody,
  ImagesGenerationsResponse,
  OpenAIProviderRuntime,
  RequestOptions,
  ResponsesApiResponse,
  UsageCallback
} from '../types.js'

export async function imageResponseCompletion (
  runtime: OpenAIProviderRuntime,
  messages: ChatMessage[],
  abortSignal?: AbortSignal,
  options?: RequestOptions
): Promise<ChatMessage> {
  const imageOptions: RequestOptions = { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS, ...options }

  // For dedicated image models (dall-e, gpt-image), prefer the /images/generations endpoint directly.
  if (isDedicatedImageModel(runtime.model)) {
    try {
      return await imageGenerationsCompletion(runtime, messages, abortSignal, imageOptions)
    } catch {
      // /images/generations failed for dedicated model; fall through to try Responses API.
      // The error is already logged inside imageGenerationsCompletion.
    }
  }

  const body = buildResponsesBody(runtime.model, messages, runtime.imageEditing)
  const responsesUrl = getResponsesUrl(runtime.baseUrl)
  const callId = runtime.logger?.logProviderCallStart({
    stream: false,
    model: runtime.model,
    baseUrl: responsesUrl,
    messages: normalizeOutgoingMessages(messages),
    tools: []
  })

  try {
    let response: Response
    try {
      response = await fetchWithRetry(runtime, responsesUrl, body, false, abortSignal, imageOptions)
    } catch (error) {
      const normalized = normalizeRequestError(error)

      // If the Responses API is not supported by this provider, fall back
      // to the /images/generations endpoint first, then Chat Completions API.
      if (shouldFallbackToChatCompletions(normalized)) {
        if (callId) {
          runtime.logger?.logProviderCallFailure(callId, normalized, { stream: false, model: runtime.model })
        }
        try {
          return await imageGenerationsCompletion(runtime, messages, abortSignal, imageOptions)
        } catch {
          return await imageChatCompletion(runtime, messages, abortSignal, imageOptions)
        }
      }

      if (!body.tools || !shouldRetryImageRequestWithoutTool(normalized)) {
        throw normalized
      }

      response = await fetchWithRetry(runtime, responsesUrl, { ...body, tools: undefined }, false, abortSignal, imageOptions)
    }

    const data = await response.json() as ResponsesApiResponse
    const message = normalizeResponsesMessage(data)
    if (data.usage && runtime.onUsage) {
      runtime.onUsage(data.usage as Parameters<UsageCallback>[0])
    }
    if (callId) {
      runtime.logger?.logProviderCallSuccess(callId, { message, raw: data })
    }
    return message
  } catch (error) {
    const normalized = normalizeRequestError(error)

    // Also catch cases where the error surfaces after the retry-without-tool.
    if (shouldFallbackToChatCompletions(normalized)) {
      if (callId) {
        runtime.logger?.logProviderCallFailure(callId, normalized, { stream: false, model: runtime.model })
      }
      try {
        return await imageGenerationsCompletion(runtime, messages, abortSignal, imageOptions)
      } catch {
        return await imageChatCompletion(runtime, messages, abortSignal, imageOptions)
      }
    }

    // Final fallback: try /images/generations before giving up.
    if (callId) {
      runtime.logger?.logProviderCallFailure(callId, normalized, { stream: false, model: runtime.model })
    }
    try {
      return await imageGenerationsCompletion(runtime, messages, abortSignal, imageOptions)
    } catch {
      throw normalized
    }
  }
}

async function imageChatCompletion (
  runtime: OpenAIProviderRuntime,
  messages: ChatMessage[],
  abortSignal?: AbortSignal,
  options?: RequestOptions
): Promise<ChatMessage> {
  const body = buildRequestBody(runtime, messages, [], false)
  const chatCompletionUrl = getChatCompletionUrl(runtime.baseUrl)
  const callId = runtime.logger?.logProviderCallStart({
    stream: false,
    model: runtime.model,
    baseUrl: chatCompletionUrl,
    messages: body.messages,
    tools: []
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
 * Use the standard /images/generations endpoint for image generation.
 * This is the most widely supported endpoint for models like dall-e-3 and gpt-image-1.
 */
async function imageGenerationsCompletion (
  runtime: OpenAIProviderRuntime,
  messages: ChatMessage[],
  abortSignal?: AbortSignal,
  options?: RequestOptions
): Promise<ChatMessage> {
  const normalizedMessages = normalizeOutgoingMessages(messages)
  const prompt = extractPromptFromMessages(normalizedMessages)
  const body: ImagesGenerationsBody = {
    model: runtime.model,
    prompt,
    n: 1,
    size: '1024x1024'
  }
  if (shouldUseImageResponseFormat(runtime.model)) {
    body.response_format = 'b64_json'
  }

  const imagesGenerationsUrl = getImagesGenerationsUrl(runtime.baseUrl)
  const callId = runtime.logger?.logProviderCallStart({
    stream: false,
    model: runtime.model,
    baseUrl: imagesGenerationsUrl,
    messages: normalizedMessages,
    tools: []
  })

  try {
    const response = await fetchWithRetry(runtime, imagesGenerationsUrl, body, false, abortSignal, options)
    const data = await response.json() as ImagesGenerationsResponse
    if (data.usage && runtime.onUsage) {
      runtime.onUsage(data.usage as Parameters<UsageCallback>[0])
    }

    const contentParts: ChatContentPart[] = []

    if (data.data && data.data.length > 0) {
      for (const item of data.data) {
        if (item.revised_prompt) {
          contentParts.push({ type: 'text', text: item.revised_prompt })
        }
        if (item.b64_json) {
          contentParts.push({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${item.b64_json}` }
          })
        } else if (item.url) {
          contentParts.push({
            type: 'image_url',
            image_url: { url: item.url }
          })
        }
      }
    }

    const message: ChatMessage = contentParts.length > 0
      ? { role: 'assistant', content: contentParts }
      : { role: 'assistant', content: '' }

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
 * Parameterized text-to-image generation for the drawing studio.
 * Uses the /images/generations endpoint with explicit size / count and an
 * optional negative prompt. Falls back to dropping the negative prompt when
 * the provider rejects it (OpenAI does not support the field).
 */
export async function generateImages (
  runtime: OpenAIProviderRuntime,
  opts: GenerateImagesOptions
): Promise<ImageGenerationResult> {
  validateOpenAIConfig(runtime)

  const prompt = opts.prompt.trim() || 'Generate an image'
  const negativePrompt = opts.negativePrompt?.trim()
  const requestOptions: RequestOptions = { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS }
  const imagesGenerationsUrl = getImagesGenerationsUrl(runtime.baseUrl)

  const sendRequest = async (includeNegative: boolean, includeAdvancedOptions: boolean, includeResponseFormat: boolean): Promise<ImageGenerationResult> => {
    const body: ImagesGenerationsBody = {
      model: runtime.model,
      prompt,
      n: opts.n && opts.n > 0 ? opts.n : 1,
      size: opts.size || '1024x1024'
    }
    if (includeResponseFormat) body.response_format = 'b64_json'
    if (includeNegative && negativePrompt) {
      body.negative_prompt = negativePrompt
    }
    if (includeAdvancedOptions) {
      const quality = normalizeImageQuality(runtime.model, opts.quality)
      if (quality) body.quality = quality
      if (shouldIncludeImageOutputFormat(runtime.model, opts.outputFormat)) {
        body.output_format = opts.outputFormat
      }
    }

    const callId = runtime.logger?.logProviderCallStart({
      stream: false,
      model: runtime.model,
      baseUrl: imagesGenerationsUrl,
      messages: [{ role: 'user', content: prompt }],
      tools: []
    })

    try {
      const response = await fetchWithRetry(runtime, imagesGenerationsUrl, body, false, opts.abortSignal, requestOptions)
      const data = await response.json() as ImagesGenerationsResponse
      if (data.usage && runtime.onUsage) {
        runtime.onUsage(data.usage as Parameters<UsageCallback>[0])
      }
      const result = extractImagesResult(data, body.output_format)
      if (callId) {
        runtime.logger?.logProviderCallSuccess(callId, { message: { role: 'assistant', content: result.images.join('\n') }, raw: data })
      }
      return result
    } catch (error) {
      const normalized = normalizeRequestError(error)
      if (callId) {
        runtime.logger?.logProviderCallFailure(callId, normalized, { stream: false, model: runtime.model })
      }
      throw normalized
    }
  }

  let includeNegative = Boolean(negativePrompt)
  let includeAdvancedOptions = Boolean(opts.quality || opts.outputFormat)
  let includeResponseFormat = shouldUseImageResponseFormat(runtime.model)
  let lastError: unknown

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await sendRequest(includeNegative, includeAdvancedOptions, includeResponseFormat)
    } catch (error) {
      lastError = error
      const normalized = error instanceof Error ? error : new Error(String(error))
      if (includeNegative && isUnsupportedImageParameterError(normalized, ['negative_prompt'])) {
        includeNegative = false
        continue
      }
      if (includeAdvancedOptions && isUnsupportedImageParameterError(normalized, ['quality', 'output_format'])) {
        includeAdvancedOptions = false
        continue
      }
      if (includeResponseFormat && isUnsupportedImageParameterError(normalized, ['response_format'])) {
        includeResponseFormat = false
        continue
      }
      throw error
    }
  }

  throw lastError
}

/**
 * Parameterized image editing for the drawing studio via the multipart
 * /images/edits endpoint (gpt-image-1 / dall-e-2 style).
 */
export async function editImages (
  runtime: OpenAIProviderRuntime,
  opts: EditImagesOptions
): Promise<ImageGenerationResult> {
  validateOpenAIConfig(runtime)

  if (!opts.images.length) {
    throw new Error(t('mainDialog.providerImageEditNeedsInput'))
  }

  const prompt = opts.prompt.trim() || 'Edit the image'
  const imagesEditsUrl = getImagesEditsUrl(runtime.baseUrl)
  const sendRequest = async (includeAdvancedOptions: boolean): Promise<ImageGenerationResult> => {
    const form = new FormData()
    form.append('model', runtime.model)
    form.append('prompt', prompt)
    form.append('n', String(opts.n && opts.n > 0 ? opts.n : 1))
    if (opts.size) {
      form.append('size', opts.size)
    }
    if (includeAdvancedOptions) {
      const quality = normalizeImageQuality(runtime.model, opts.quality)
      if (quality) form.append('quality', quality)
      if (shouldIncludeImageOutputFormat(runtime.model, opts.outputFormat)) {
        form.append('output_format', opts.outputFormat)
      }
    }

    const multiple = opts.images.length > 1
    opts.images.forEach((dataUrl, index) => {
      const { blob, ext } = dataUrlToBlob(dataUrl)
      form.append(multiple ? 'image[]' : 'image', blob, `image-${index}.${ext}`)
    })

    if (opts.mask) {
      const { blob, ext } = dataUrlToBlob(opts.mask)
      form.append('mask', blob, `mask.${ext}`)
    }

    const callId = runtime.logger?.logProviderCallStart({
      stream: false,
      model: runtime.model,
      baseUrl: imagesEditsUrl,
      messages: [{ role: 'user', content: prompt }],
      tools: []
    })

    try {
      const response = await fetchMultipartWithRetry(
        runtime,
        imagesEditsUrl,
        form,
        opts.abortSignal,
        { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS }
      )
      const data = await response.json() as ImagesGenerationsResponse
      if (data.usage && runtime.onUsage) {
        runtime.onUsage(data.usage as Parameters<UsageCallback>[0])
      }
      const result = extractImagesResult(data, includeAdvancedOptions ? opts.outputFormat : undefined)
      if (callId) {
        runtime.logger?.logProviderCallSuccess(callId, { message: { role: 'assistant', content: result.images.join('\n') }, raw: data })
      }
      return result
    } catch (error) {
      const normalized = normalizeRequestError(error)
      if (callId) {
        runtime.logger?.logProviderCallFailure(callId, normalized, { stream: false, model: runtime.model })
      }
      throw normalized
    }
  }

  try {
    return await sendRequest(Boolean(opts.quality || opts.outputFormat))
  } catch (error) {
    const normalized = normalizeRequestError(error)
    if (isUnsupportedImageParameterError(normalized, ['quality', 'output_format'])) {
      return await sendRequest(false)
    }
    throw normalized
  }
}

function extractPromptFromMessages (messages: ChatMessage[]): string {
  let prompt = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        prompt = msg.content
      } else if (Array.isArray(msg.content)) {
        prompt = msg.content
          .filter(part => part.type === 'text')
          .map(part => (part as ChatContentTextPart).text)
          .join('\n')
      }
      break
    }
  }

  return prompt || 'Generate an image'
}
