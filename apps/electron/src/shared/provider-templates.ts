/**
 * Built-in provider templates. A template is a read-only, pre-filled provider
 * form: address, protocol, default models, pricing and the vendor's website
 * links. "Use template" copies it into a real provider owned by the user, who
 * only has to paste an API key.
 *
 * Templates never enter the user's provider list, never sync to the Rust
 * harness and never travel through config import/export.
 *
 * Model ids, context windows and prices are checked against the vendor's
 * public docs on `verifiedAt`; keep that date honest when editing.
 */
export type ProviderTemplateProtocol = 'openai-chat' | 'openai-responses' | 'anthropic'

export interface ProviderTemplateLinks {
  /** Brand homepage, required. */
  homepage: string
  /** Sign-up page; falls back to the homepage. */
  signup?: string
  /** Console / dashboard. */
  console?: string
  /** API key management page; "Get a key" opens this first. */
  apiKeys?: string
  /** Top-up / billing page. */
  billing?: string
  /** Model & pricing docs. */
  pricing?: string
}

export interface ProviderTemplateModel {
  id: string
  contextWindow: number
  /** USD per million tokens. */
  pricing?: { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }
  capabilities?: { imageGeneration?: boolean; imageEditing?: boolean }
}

export interface ProviderTemplate {
  /** Stable id such as `deepseek`; never renamed once shipped. */
  id: string
  name: string
  baseUrl: string
  apiProtocol: ProviderTemplateProtocol
  models: ProviderTemplateModel[]
  defaultModel: string
  links: ProviderTemplateLinks
  /** Regex source used to recognise a pasted key; a generic rule applies when absent. */
  apiKeyPattern?: string
  apiKeyPlaceholder?: string
  /** The one template the empty states push first. Exactly one template sets this. */
  recommended?: boolean
  order: number
  source: 'builtin' | 'remote'
  /** `YYYY-MM-DD` the data was last checked against the vendor docs. */
  verifiedAt: string
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiProtocol: 'openai-chat',
    // Source: https://api-docs.deepseek.com/quick_start/pricing (2026-09-20).
    // `deepseek-flash` = DeepSeek-V4.1-Flash, `deepseek-v4-pro` = DeepSeek-V4-Pro-0813;
    // both 1M context, 384K max output. The old `deepseek-chat` / `deepseek-reasoner`
    // names were retired on 2026-07-24 and must not come back here. Prices are the
    // USD peak-hour list prices; DeepSeek bills half of that off-peak, which the
    // flat per-million pricing model here cannot express, so this is the upper bound.
    models: [
      { id: 'deepseek-flash', contextWindow: 1_000_000, pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006 } },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000, pricing: { inputPerMillion: 1.32, outputPerMillion: 3.96, cacheReadPerMillion: 0.044 } }
    ],
    /** The model every official quick-start example calls. */
    defaultModel: 'deepseek-flash',
    links: {
      homepage: 'https://www.deepseek.com',
      signup: 'https://platform.deepseek.com/sign_up',
      console: 'https://platform.deepseek.com',
      apiKeys: 'https://platform.deepseek.com/api_keys',
      billing: 'https://platform.deepseek.com/top_up',
      pricing: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
    },
    apiKeyPattern: '^sk-[A-Za-z0-9]{20,}$',
    apiKeyPlaceholder: 'sk-…',
    recommended: true,
    order: 10,
    source: 'builtin',
    verifiedAt: '2026-09-20'
  }
]

const TEMPLATE_BY_ID = new Map(PROVIDER_TEMPLATES.map(template => [template.id, template]))

export function getProviderTemplate (id: string): ProviderTemplate | undefined {
  return TEMPLATE_BY_ID.get(id)
}

export function getRecommendedProviderTemplate (): ProviderTemplate {
  return PROVIDER_TEMPLATES.find(template => template.recommended) || PROVIDER_TEMPLATES[0]
}

/** Every https host a template links to; the main process only opens these. */
export function providerTemplateHosts (): Set<string> {
  const hosts = new Set<string>()
  for (const template of PROVIDER_TEMPLATES) {
    for (const url of Object.values(template.links)) {
      if (!url) continue
      try {
        hosts.add(new URL(url).host.toLowerCase())
      } catch {
        /* a malformed template link is caught by tests, not at runtime */
      }
    }
  }
  return hosts
}

/** Generic fallback: the common key prefixes, or a long unspaced token. */
const GENERIC_KEY_PATTERN = /^(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,200})$/

/** Whether `text` looks like an API key for `template` (or any provider when omitted). */
export function looksLikeApiKey (text: string, template?: Pick<ProviderTemplate, 'apiKeyPattern'> | null): boolean {
  const value = text.trim()
  if (!value || /\s/.test(value) || value.length < 20 || value.length > 200) return false
  if (template?.apiKeyPattern) {
    try {
      return new RegExp(template.apiKeyPattern).test(value)
    } catch {
      /* fall through to the generic rule */
    }
  }
  return GENERIC_KEY_PATTERN.test(value)
}

/** Whether `url` may be opened by the "open website" IPC: https only, host on the allow-list. */
export function isAllowedExternalUrl (url: string, extraHosts: Iterable<string> = []): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.host.toLowerCase()
  if (providerTemplateHosts().has(host)) return true
  for (const extra of extraHosts) {
    if (extra.toLowerCase() === host) return true
  }
  return false
}
