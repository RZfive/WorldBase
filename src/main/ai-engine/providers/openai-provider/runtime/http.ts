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

export const STANDARD_REQUEST_TIMEOUT_MS = 60000
export const IMAGE_REQUEST_TIMEOUT_MS = 600000
export const STREAM_IDLE_TIMEOUT_MS = 90000
export const STREAM_IDLE_TIMEOUT_MESSAGE = 'AI stream idle timed out'

type JsonRequestBody = ChatCompletionBody | ResponsesBody | ImagesGenerationsBody

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

export async function fetchWithRetry (
  runtime: Pick<OpenAIProviderRuntime, 'apiKey' | 'baseUrl' | 'model'>,
  url: string,
  body: JsonRequestBody,
  stream: boolean,
  abortSignal?: AbortSignal,
  options?: RequestOptions
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
          Authorization: `Bearer ${runtime.apiKey}`
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
      const error = new Error(`OpenAI API error (${response.status}): ${errorText}`)
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

    await delay(Math.min(1000 * (2 ** (attempt - 1)), 5000))
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
      const error = new Error(`OpenAI API error (${response.status}): ${errorText}`)
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

    await delay(Math.min(1000 * (2 ** (attempt - 1)), 5000))
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
  timeoutMs: number
): Promise<StreamReadResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null

  try {
    const readPromise = reader.read()
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        void reader.cancel(STREAM_IDLE_TIMEOUT_MESSAGE).catch(() => {
          // Ignore reader cancellation failures and surface the timeout instead.
        })
        reject(new Error(STREAM_IDLE_TIMEOUT_MESSAGE))
      }, timeoutMs)
    })

    return await Promise.race([readPromise, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
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

async function delay (ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
