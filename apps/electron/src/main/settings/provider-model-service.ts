export interface FetchProviderModelsInput {
  baseUrl: string
  apiKey: string
  apiProtocol?: 'openai' | 'anthropic'
}

const REQUEST_TIMEOUT_MS = 15_000
const ANTHROPIC_VERSION = '2023-06-01'

function resolveProtocol (input: FetchProviderModelsInput): 'openai' | 'anthropic' {
  if (input.apiProtocol === 'openai' || input.apiProtocol === 'anthropic') {
    return input.apiProtocol
  }
  return input.baseUrl.toLowerCase().includes('anthropic.com') ? 'anthropic' : 'openai'
}

export function buildProviderModelsUrl (baseUrl: string, protocol: 'openai' | 'anthropic'): string {
  const url = new URL(baseUrl.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must use HTTP or HTTPS')
  }

  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = protocol === 'anthropic' && !path.endsWith('/v1')
    ? `${path}/v1/models`
    : `${path}/models`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function parseProviderModels (payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const record = payload as Record<string, unknown>
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models) ? record.models : []
  const models = entries.flatMap(entry => {
    if (typeof entry === 'string') return [entry.trim()]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const id = (entry as Record<string, unknown>).id
    return typeof id === 'string' ? [id.trim()] : []
  }).filter(Boolean)

  return [...new Set(models)].sort((left, right) => left.localeCompare(right))
}

function responseErrorMessage (body: string): string {
  try {
    const payload = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    const message = payload.error?.message ?? payload.message
    if (typeof message === 'string') return message.trim().slice(0, 300)
  } catch {
    // A plain-text error body is still useful to the settings UI.
  }
  return body.trim().slice(0, 300)
}

export async function fetchProviderModels (input: FetchProviderModelsInput): Promise<string[]> {
  const baseUrl = input.baseUrl.trim()
  const apiKey = input.apiKey.trim()
  if (!baseUrl) throw new Error('Base URL is required')
  if (!apiKey) throw new Error('API key is required')

  const protocol = resolveProtocol(input)
  const url = buildProviderModelsUrl(baseUrl, protocol)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: protocol === 'anthropic'
        ? {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION
          }
        : { Authorization: `Bearer ${apiKey}` }
    })
    const body = await response.text()
    if (!response.ok) {
      const detail = responseErrorMessage(body)
      throw new Error(`Provider model request failed (${response.status})${detail ? `: ${detail}` : ''}`)
    }

    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      throw new Error('Provider returned invalid JSON')
    }
    const models = parseProviderModels(payload)
    if (models.length === 0) throw new Error('Provider returned no models')
    return models
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Provider model request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
