/**
 * Cost Tracker — 成本追踪
 *
 * 按模型统计 token 消耗和预估成本，支持会话级别的实时追踪。
 * 通过 OpenAI 兼容 API 的 usage 字段获取 token 数据。
 */

export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
}

export interface UsageEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cost: number
  timestamp: number
}

export interface UsageReport {
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  callCount: number
  byModel: Record<string, { cost: number; calls: number; inputTokens: number; outputTokens: number }>
}

/** OpenAI API usage 字段 */
export interface ApiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
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
  ['deepseek-chat', { inputPerMillion: 0.14, outputPerMillion: 0.28 }],
  ['deepseek-reasoner', { inputPerMillion: 0.55, outputPerMillion: 2.19 }]
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
 * Resolve a model's price using the exact matching rules used by CostTracker.
 * Electron's Rust client uses this when it serializes provider definitions, so
 * a backend switch cannot silently zero out custom or built-in pricing.
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

export class CostTracker {
  private pricing = new Map<string, ModelPricing>(DEFAULT_MODEL_PRICING)
  private sessionUsage: UsageEntry[] = []
  private budgetLimit?: number

  /** 设置/更新模型定价 */
  setModelPricing (model: string, pricing: ModelPricing): void {
    this.pricing.set(model, pricing)
  }

  /** 设置会话预算上限 (美元) */
  setBudgetLimit (limit: number | undefined): void {
    this.budgetLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? limit
      : undefined
  }

  /** 记录一次 API 调用的 token 消耗 */
  record (model: string, usage: ApiUsage | undefined | null): void {
    if (!usage) return

    const inputTokens = usage.prompt_tokens ?? 0
    const outputTokens = usage.completion_tokens ?? 0
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
    const cost = this.calculateCost(model, inputTokens, outputTokens, cacheReadTokens)

    this.sessionUsage.push({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
      cost,
      timestamp: Date.now()
    })
  }

  /** 获取当前会话总成本 */
  getSessionCost (): number {
    return this.sessionUsage.reduce((sum, entry) => sum + entry.cost, 0)
  }

  /** 检查是否超过预算 */
  isOverBudget (): boolean {
    if (this.budgetLimit === undefined) return false
    return this.getSessionCost() >= this.budgetLimit
  }

  /** 获取使用报告 */
  getUsageReport (): UsageReport {
    const byModel: UsageReport['byModel'] = {}
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCost = 0

    for (const entry of this.sessionUsage) {
      totalInputTokens += entry.inputTokens
      totalOutputTokens += entry.outputTokens
      totalCacheReadTokens += entry.cacheReadTokens ?? 0
      totalCost += entry.cost

      if (!byModel[entry.model]) {
        byModel[entry.model] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 }
      }
      byModel[entry.model].cost += entry.cost
      byModel[entry.model].calls++
      byModel[entry.model].inputTokens += entry.inputTokens
      byModel[entry.model].outputTokens += entry.outputTokens
    }

    return {
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      callCount: this.sessionUsage.length,
      byModel
    }
  }

  /** 重置会话数据 */
  reset (): void {
    this.sessionUsage = []
  }

  private calculateCost (model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
    const pricing = this.findPricing(model)
    if (!pricing) return 0

    const inputCost = (inputTokens * pricing.inputPerMillion) / 1_000_000
    const outputCost = (outputTokens * pricing.outputPerMillion) / 1_000_000
    const cacheReadCost = cacheReadTokens > 0 && pricing.cacheReadPerMillion
      ? (cacheReadTokens * pricing.cacheReadPerMillion) / 1_000_000
      : 0

    return inputCost + outputCost + cacheReadCost
  }

  /** 模糊匹配模型名称 — 支持版本后缀、provider 前缀等 */
  private findPricing (model: string): ModelPricing | undefined {
    return resolveModelPricing(model, Object.fromEntries(this.pricing))
  }
}
