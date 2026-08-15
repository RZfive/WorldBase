import { normalizeAbortReason } from '../../../abort-utils.js'
import { t } from '../../../../i18n/main-i18n.js'
import type {
  ChatCompletionBody,
  ImagesGenerationsBody,
  OpenAIProviderRuntime,
  RequestOptions,
  ResponsesBody,
  StreamReadResult
} from '../types.js'
import type { AnthropicMessagesBody } from '../../anthropic-provider/types.js'

export const STANDARD_REQUEST_TIMEOUT_MS = 60000
export const IMAGE_REQUEST_TIMEOUT_MS = 600000
export const STREAM_IDLE_TIMEOUT_MS = 90000
export const STREAM_IDLE_TIMEOUT_MESSAGE = 'AI stream idle timed out'

export const ANTHROPIC_VERSION = '2023-06-01'

type JsonRequestBody = ChatCompletionBody | ResponsesBody | ImagesGenerationsBody | AnthropicMessagesBody

export function validateOpenAIConfig (runtime: Pick<OpenAIProviderRuntime, 'apiKey' | 'baseUrl' | 'model'>): void {
  if (!runtime.apiKey.trim()) {
    throw new Error(t('mainDialog.providerCurrentApiKeyMissing'))
  }
  if (!runtime.baseUrl.trim()) {
    throw new Error(t('mainDialog.providerCurrentBaseUrlMissing'))
  }
  if (!runtime.model.trim()) {
    throw new Error(t('mainDialog.providerCurrentModelMissing'))
  }
}

/**
 * Default request headers: OpenAI-style bearer auth.
 *
 * Anthropic-protocol requests send BOTH x-api-key (the native Anthropic
 * header) and Authorization: Bearer (accepted by Anthropic and required by
 * Anthropic-compatible gateways such as Volcengine Ark, which reject
 * x-api-key alone with a 401).
 */
export function buildAuthHeaders (
  runtime: Pick<OpenAIProviderRuntime, 'apiKey'>,
  headerMode: 'bearer' | 'anthropic' = 'bearer'
): Record<string, string> {
  if (headerMode === 'anthropic') {
    return {
      'x-api-key': runtime.apiKey,
      Authorization: `Bearer ${runtime.apiKey}`,
      'anthropic-version': ANTHROPIC_VERSION
    }
  }
  return { Authorization: `Bearer ${runtime.apiKey}` }
}

export async function fetchWithRetry (
  runtime: Pick<OpenAIProviderRuntime, 'apiKey' | 'baseUrl' | 'model'>,
  url: string,
  body: JsonRequestBody,
  stream: boolean,
  abortSignal?: AbortSignal,
  options?: RequestOptions,
  headerMode: 'bearer' | 'anthropic' = 'bearer'
): Promise<Response> {
  validateOpenAIConfig(runtime)

  const maxAttempts = 3
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const onAbort = () => {
      if (!abortSignal) return
      controller.abort(normalizeAbortReason(abortSignal.reason))
    }
    if (abortSignal) {
      if (abortSignal.aborted) {
        throw normalizeAbortReason(abortSignal.reason)
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }
    const timeoutMs = options?.timeoutMs ?? (stream ? undefined : STANDARD_REQUEST_TIMEOUT_MS)
    const timeout = timeoutMs !== undefined
      ? setTimeout(() => controller.abort(new Error('AI request timed out')), timeoutMs)
      : null

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(runtime, headerMode)
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (response.ok) {
        if (timeout) clearTimeout(timeout)
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort)
        }
        return response
      }

      const errorText = await response.text()
      const error = new Error(`AI API error (${response.status}) POST ${url}: ${errorText}`)
      if (timeout) clearTimeout(timeout)
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
        throw error
      }

      lastError = error
    } catch (err) {
      if (timeout) clearTimeout(timeout)
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }
      if (abortSignal?.aborted) {
        throw normalizeAbortReason(abortSignal.reason)
      }
      if (controller.signal.aborted) {
        throw normalizeAbortReason(controller.signal.reason)
      }
      const normalized = normalizeRequestError(err)
      if (!isRetryableError(normalized) || attempt === maxAttempts) {
        throw normalized
      }
      lastError = normalized
    }

    await delay(Math.min(1000 * (2 ** (attempt - 1)), 5000), abortSignal)
  }

  throw lastError || new Error('AI request failed')
}

/**
 * Multipart sibling of fetchWithRetry — reuses the same timeout / abort /
 * retry skeleton but sends FormData and lets fetch set the boundary header.
 */
export async function fetchMultipartWithRetry (
  runtime: Pick<OpenAIProviderRuntime, 'apiKey'>,
  url: string,
  form: FormData,
  abortSignal?: AbortSignal,
  options?: RequestOptions
): Promise<Response> {
  const maxAttempts = 3
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const onAbort = () => {
      if (!abortSignal) return
      controller.abort(normalizeAbortReason(abortSignal.reason))
    }
    if (abortSignal) {
      if (abortSignal.aborted) {
        throw normalizeAbortReason(abortSignal.reason)
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }
    const timeoutMs = options?.timeoutMs ?? STANDARD_REQUEST_TIMEOUT_MS
    const timeout = setTimeout(() => controller.abort(new Error('AI request timed out')), timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtime.apiKey}`
        },
        body: form,
        signal: controller.signal
      })

      if (response.ok) {
        clearTimeout(timeout)
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
        return response
      }

      const errorText = await response.text()
      const error = new Error(`AI API error (${response.status}) POST ${url}: ${errorText}`)
      clearTimeout(timeout)
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)

      if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
        throw error
      }
      lastError = error
    } catch (err) {
      clearTimeout(timeout)
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      if (abortSignal?.aborted) {
        throw normalizeAbortReason(abortSignal.reason)
      }
      if (controller.signal.aborted) {
        throw normalizeAbortReason(controller.signal.reason)
      }
      const normalized = normalizeRequestError(err)
      if (!isRetryableError(normalized) || attempt === maxAttempts) {
        throw normalized
      }
      lastError = normalized
    }

    await delay(Math.min(1000 * (2 ** (attempt - 1)), 5000), abortSignal)
  }

  throw lastError || new Error('AI request failed')
}

export function normalizeRequestError (error: unknown): Error {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return normalizeAbortReason(error.cause)
    }
    return error
  }
  return new Error(String(error))
}

export async function readStreamChunkWithIdleTimeout (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<StreamReadResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null

  try {
    if (abortSignal?.aborted) throw normalizeAbortReason(abortSignal.reason)
    const readPromise = reader.read()
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel(abortSignal?.reason).catch(() => {})
        reject(normalizeAbortReason(abortSignal?.reason))
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true })
    })
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        void reader.cancel(STREAM_IDLE_TIMEOUT_MESSAGE).catch(() => {
          // Ignore reader cancellation failures and surface the timeout instead.
        })
        reject(new Error(STREAM_IDLE_TIMEOUT_MESSAGE))
      }, timeoutMs)
    })

    return await Promise.race([readPromise, timeoutPromise, abortPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (abortSignal && onAbort) abortSignal.removeEventListener('abort', onAbort)
  }
}

function isRetryableStatus (status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504)
}

function isRetryableError (error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes('terminated') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('eai_again') ||
    message.includes('aborted') ||
    message.includes('unexpected end of json input')
}

async function delay (ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) throw normalizeAbortReason(abortSignal.reason)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      reject(normalizeAbortReason(abortSignal?.reason))
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
  })
}
