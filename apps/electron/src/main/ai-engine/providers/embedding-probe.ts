import type { EmbeddingDistanceMetric } from '../../../shared/agent-workspace-types.js'

export interface EmbeddingProbeResult {
  ok: boolean
  dimensions?: number
  latencyMs?: number
  error?: string
}

export interface EmbeddingProbeInput {
  baseUrl: string
  apiKey: string
  modelId: string
  distance?: EmbeddingDistanceMetric
  queryPrefix?: string
  documentPrefix?: string
}

/**
 * OpenAI-compatible `/embeddings` endpoint resolution, mirroring the chat
 * provider's base-URL normalization rules.
 */
export function getEmbeddingsUrl (baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  if (normalized.endsWith('/embeddings')) return normalized
  if (normalized.endsWith('/chat/completions')) {
    return `${normalized.slice(0, -'/chat/completions'.length)}/embeddings`
  }
  return `${normalized}/embeddings`
}

/**
 * Probe a remote embedding model: send one tiny input and read back the
 * vector dimension. Runs only in the main process (design §7.4) so renderer
 * code never touches the provider API.
 */
export async function probeEmbeddingModel (input: EmbeddingProbeInput): Promise<EmbeddingProbeResult> {
  const url = getEmbeddingsUrl(input.baseUrl)
  if (!url) {
    return { ok: false, error: 'provider base url is empty' }
  }
  const text = `${input.queryPrefix || 'query: '}dimension probe`
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({ model: input.modelId, input: [text] })
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `HTTP ${response.status}: ${body.slice(0, 200)}`
      }
    }
    const payload = await response.json() as { data?: Array<{ embedding?: unknown }> }
    const embedding = payload.data?.[0]?.embedding
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: 'response has no embedding array' }
    }
    return {
      ok: true,
      dimensions: embedding.length,
      latencyMs: Date.now() - startedAt
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
