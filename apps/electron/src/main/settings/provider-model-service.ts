import type { ProviderApiProtocol } from './settings-store.js'
import { clampReasoningEffort } from '../../shared/reasoning-effort.js'

export { clampReasoningEffort }

export interface FetchProviderModelsInput {
  baseUrl: string
  apiKey: string
  apiProtocol?: ProviderApiProtocol
}

/** Header style for the model catalog — both OpenAI wire protocols share Bearer auth. */
export type ModelCatalogStyle = 'openai' | 'anthropic'

const REQUEST_TIMEOUT_MS = 15_000
const ANTHROPIC_VERSION = '2023-06-01'

export function buildProviderModelsUrl (baseUrl: string, protocol: ModelCatalogStyle): string {
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
  const models = catalogEntries(payload).flatMap(entry => {
    if (typeof entry === 'string') return [entry.trim()]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    // Zhipu-style catalogs key entries by `slug`; OpenAI-style by `id`.
    const id = typeof record.id === 'string' ? record.id : typeof record.slug === 'string' ? record.slug : ''
    return id.trim() ? [id.trim()] : []
  }).filter(Boolean)

  return [...new Set(models)].sort((left, right) => left.localeCompare(right))
}

/** Model facts a gateway declares about one model via its /models catalog. */
export interface ProviderModelMetadata {
  /** The only effort values this model accepts; empty means unknown. */
  supportedReasoningEfforts: string[]
  defaultReasoningEffort?: string
  /** Declared context window in tokens, when the catalog reports one. */
  contextWindow?: number
}

/**
 * Extract per-model metadata from a catalog payload. Zhipu declares
 * `supported_reasoning_levels` + `default_reasoning_level` + `context_window`
 * (glm-5.3 only accepts low/high/max); deepseek nests the same facts under
 * `effort: { supported_levels, default_level }`; gateways without the fields
 * yield no entry, which callers must treat as "unknown, keep current values".
 */
export function parseProviderModelMetadata (payload: unknown): Record<string, ProviderModelMetadata> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const metadata: Record<string, ProviderModelMetadata> = {}
  for (const entry of catalogEntries(payload)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry === 'string') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : typeof record.slug === 'string' ? record.slug : ''
    if (!id.trim()) continue
    const efforts = declaredEfforts(record)
    const contextWindow = declaredContextWindow(record)
    if (efforts.length === 0 && contextWindow === undefined) continue
    const declaredDefault = record.default_reasoning_level ?? record.defaultReasoningLevel
      ?? (record.effort && typeof record.effort === 'object' ? (record.effort as Record<string, unknown>).default_level : undefined)
    metadata[id.trim()] = {
      supportedReasoningEfforts: efforts,
      ...(typeof declaredDefault === 'string' && declaredDefault.trim() && efforts.includes(declaredDefault.trim())
        ? { defaultReasoningEffort: declaredDefault.trim() }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {})
    }
  }
  return metadata
}

function declaredEfforts (record: Record<string, unknown>): string[] {
  const levels = record.supported_reasoning_levels ?? record.supportedReasoningLevels
  if (Array.isArray(levels)) {
    return [...new Set(levels.map(level => {
      if (typeof level === 'string') return level.trim()
      const effort = (level as Record<string, unknown> | null)?.effort
      return typeof effort === 'string' ? effort.trim() : ''
    }).filter(Boolean))]
  }
  // deepseek-style: effort: { supported_levels: ["low", ...], default_level: "high" }
  const nested = record.effort
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const supported = (nested as Record<string, unknown>).supported_levels
    if (Array.isArray(supported)) {
      return [...new Set(supported.filter((level): level is string => typeof level === 'string' && level.trim().length > 0).map(level => level.trim()))]
    }
  }
  return []
}

function declaredContextWindow (record: Record<string, unknown>): number | undefined {
  for (const key of ['context_window', 'context_length', 'max_context_window']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

function catalogEntries (payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const record = payload as Record<string, unknown>
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models) ? record.models : []
  return entries
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

async function fetchCatalogWithStyle (baseUrl: string, apiKey: string, style: ModelCatalogStyle): Promise<unknown> {
  const url = buildProviderModelsUrl(baseUrl, style)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: style === 'anthropic'
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

    try {
      return JSON.parse(body)
    } catch {
      throw new Error('Provider returned invalid JSON')
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Provider model request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * A wrong-header-style catalog request fails with auth/routing errors; other
 * failures (network, invalid payload) will not improve by switching styles.
 */
function catalogErrorMightBeHeaderStyle (error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return ['(401)', '(403)', '(404)', '(405)'].some(marker => message.includes(marker))
}

/**
 * Fetch the remote model catalog once and parse both the model ids and the
 * per-model metadata (reasoning levels, context window) out of the same
 * payload.
 */
export async function fetchProviderCatalog (input: FetchProviderModelsInput): Promise<{
  models: string[]
  modelMetadata: Record<string, ProviderModelMetadata>
}> {
  const baseUrl = input.baseUrl.trim()
  const apiKey = input.apiKey.trim()
  if (!baseUrl) throw new Error('Base URL is required')
  if (!apiKey) throw new Error('API key is required')

  const payload = await fetchCatalogPayload(input, baseUrl, apiKey)
  return {
    models: parseProviderModels(payload),
    modelMetadata: parseProviderModelMetadata(payload)
  }
}

/** Fetch the remote model catalog ids. */
export async function fetchProviderModels (input: FetchProviderModelsInput): Promise<string[]> {
  const models = (await fetchProviderCatalog(input)).models
  if (models.length === 0) throw new Error('Provider returned no models')
  return models
}

async function fetchCatalogPayload (input: FetchProviderModelsInput, baseUrl: string, apiKey: string): Promise<unknown> {
  if (input.apiProtocol === 'anthropic') {
    return fetchCatalogWithStyle(baseUrl, apiKey, 'anthropic')
  }
  if (input.apiProtocol === 'openai-chat' || input.apiProtocol === 'openai-responses') {
    return fetchCatalogWithStyle(baseUrl, apiKey, 'openai')
  }

  try {
    return await fetchCatalogWithStyle(baseUrl, apiKey, 'openai')
  } catch (error) {
    if (!catalogErrorMightBeHeaderStyle(error)) throw error
    return fetchCatalogWithStyle(baseUrl, apiKey, 'anthropic')
  }
}
