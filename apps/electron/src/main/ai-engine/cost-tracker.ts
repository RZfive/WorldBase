/**
 * Model pricing catalog and resolution.
 *
 * Session-level cost tracking moved to the Rust harness; this module keeps the
 * shared pricing table so Electron and the Rust client agree on model costs.
 */

export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
}

export const DEFAULT_MODEL_PRICING: Array<[string, ModelPricing]> = [
  ['gpt-4o', { inputPerMillion: 2.5, outputPerMillion: 10 }],
  ['gpt-4o-mini', { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  ['gpt-4.1', { inputPerMillion: 2, outputPerMillion: 8 }],
  ['gpt-4.1-mini', { inputPerMillion: 0.4, outputPerMillion: 1.6 }],
  ['gpt-4.1-nano', { inputPerMillion: 0.1, outputPerMillion: 0.4 }],
  ['o3', { inputPerMillion: 2, outputPerMillion: 8 }],
  ['o3-mini', { inputPerMillion: 1.1, outputPerMillion: 4.4 }],
  ['o4-mini', { inputPerMillion: 1.1, outputPerMillion: 4.4 }],
  ['claude-sonnet-4-20250514', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-opus-4-20250514', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['claude-3-5-sonnet-20241022', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-3-5-haiku-20241022', { inputPerMillion: 0.8, outputPerMillion: 4 }],
  // DeepSeek USD peak-hour list prices (off-peak is half), per
  // https://api-docs.deepseek.com/quick_start/pricing on 2026-09-20. Must stay
  // equal to the DeepSeek template in src/shared/provider-templates.ts. The
  // legacy `deepseek-v4-flash*` names are routed to V4.1-Flash and billed at
  // the Flash price; `deepseek-chat` / `deepseek-reasoner` were retired.
  ['deepseek-flash', { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006 }],
  ['deepseek-v4-flash', { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006 }],
  ['deepseek-v4-pro', { inputPerMillion: 1.32, outputPerMillion: 3.96, cacheReadPerMillion: 0.044 }]
]

export function resolveDefaultModelPricing (model: string): ModelPricing | undefined {
  if (!model) return undefined

  const normalized = model.trim()
  const exactMatch = DEFAULT_MODEL_PRICING.find(([key]) => key === normalized)
  if (exactMatch) return { ...exactMatch[1] }

  const stripped = normalized.replace(/^(openai\/|anthropic\/|google\/|deepseek\/)/, '')
  const strippedMatch = DEFAULT_MODEL_PRICING.find(([key]) => key === stripped)
  if (strippedMatch) return { ...strippedMatch[1] }

  let bestMatch: ModelPricing | undefined
  let bestMatchLength = 0
  for (const [key, pricing] of DEFAULT_MODEL_PRICING) {
    if (stripped.includes(key) && key.length > bestMatchLength) {
      bestMatch = pricing
      bestMatchLength = key.length
    }
  }

  return bestMatch ? { ...bestMatch } : undefined
}

/**
 * Resolve a model's price with exact match, provider-prefix stripping, and
 * longest-substring fallback. Electron's Rust client uses this when it
 * serializes provider definitions, so a backend switch cannot silently zero
 * out custom or built-in pricing.
 */
export function resolveModelPricing (
  model: string,
  overrides: Record<string, ModelPricing> = {}
): ModelPricing | undefined {
  if (!model) return undefined

  const pricing = new Map<string, ModelPricing>(DEFAULT_MODEL_PRICING)
  for (const [name, value] of Object.entries(overrides)) {
    pricing.set(name, value)
  }

  if (pricing.has(model)) return { ...pricing.get(model)! }

  const normalized = model.replace(/^(openai\/|anthropic\/|google\/|deepseek\/)/, '')
  if (pricing.has(normalized)) return { ...pricing.get(normalized)! }

  let bestMatch: ModelPricing | undefined
  let bestMatchLength = 0
  for (const [key, value] of pricing) {
    if (normalized.includes(key) && key.length > bestMatchLength) {
      bestMatch = value
      bestMatchLength = key.length
    }
  }
  return bestMatch ? { ...bestMatch } : undefined
}
