/**
 * Daily suggestions: the chat empty state shows three groups of cards.
 *
 *  - `explore`:   a static, weekly-rotating pool of product-capability tips. Always on.
 *  - `daily`:     LLM-generated ideas/questions, opt-in from Settings, constrained to
 *                 the suggestion types the user selected.
 *  - `knowledge`: curiosity hooks. One "random" seed a day from a built-in pool
 *                 (works without a model) plus optional LLM items drawn from other
 *                 disciplines, the user's own field, or declared interests.
 *
 * Clicking a card drops the user straight into a working scene: the prompt is
 * filled (or sent) and the composer toggles described by `scene` are applied.
 * Knowledge cards never carry a scene: they start a conversation, not a task.
 */

export type SuggestionLayer = 'daily' | 'explore' | 'knowledge'

export type KnowledgeSource =
  | 'cross-discipline'
  | 'work-domain'
  | 'interest'
  | 'random'

export const KNOWLEDGE_SOURCES: readonly KnowledgeSource[] = [
  'random',
  'cross-discipline',
  'work-domain',
  'interest'
] as const

/** Sources that need a model. `random` is served from the local seed pool. */
export const LLM_KNOWLEDGE_SOURCES: readonly KnowledgeSource[] = ['cross-discipline', 'work-domain', 'interest'] as const

export interface KnowledgeMeta {
  source: KnowledgeSource
  /** Seed pool entry id for `random`; otherwise the model's discipline label (≤ 20 chars). */
  discipline?: string
  seedId?: string
}

export type KnowledgeCountPerSource = 1 | 2

export interface KnowledgePreferences {
  /** Default on: the random seed does not need a model. */
  enabled: boolean
  /** Never empty; falls back to `['random']`. */
  sources: KnowledgeSource[]
  /** Free-text topics the user wants to learn about. */
  interests: string[]
  /** Short profession / field description, may be empty. */
  profession: string
  /** Items per LLM source. The random source is always exactly one. */
  countPerSource: KnowledgeCountPerSource
}

export const KNOWLEDGE_MAX_INTERESTS = 10
export const KNOWLEDGE_INTEREST_MAX_LENGTH = 30
export const KNOWLEDGE_PROFESSION_MAX_LENGTH = 60
export const KNOWLEDGE_SHUFFLE_LIMIT = 5

export type SuggestionType =
  | 'new-idea'
  | 'improve-project'
  | 'learn-question'
  | 'automation'
  | 'feature-tip'
  | 'data-insight'

export const SUGGESTION_TYPES: readonly SuggestionType[] = [
  'new-idea',
  'improve-project',
  'learn-question',
  'automation',
  'feature-tip',
  'data-insight'
] as const

export type SuggestionFeatureTag =
  | 'plan-mode'
  | 'computer-use'
  | 'skills'
  | 'mcp'
  | 'scheduled-tasks'
  | 'long-term-goals'
  | 'agent-groups'
  | 'document-workspace'
  | 'folder-workspace'
  | 'project'
  | 'data-analysis'
  | 'web-search'
  | 'image-studio'

export type SuggestionSendMode = 'fill' | 'send'

export type DailySuggestionCountPerType = 2 | 3 | 5

export type DailySuggestionTrigger =
  | { kind: 'time'; timeOfDay: string }
  | { kind: 'first-open' }

export interface DailySuggestionContextScope {
  /** Project names, types and run state. */
  projects: boolean
  /** Titles of the most recent conversations (never message bodies). */
  conversationTitles: boolean
  /** Short preview text of recent conversations. Off by default. */
  conversationSummaries: boolean
}

export interface DailySuggestionPreferences {
  enabled: boolean
  types: SuggestionType[]
  countPerType: DailySuggestionCountPerType
  trigger: DailySuggestionTrigger
  providerId?: string | null
  modelId?: string | null
  context: DailySuggestionContextScope
  knowledge: KnowledgePreferences
}

export interface SuggestionScene {
  targetProjectId?: string
  planMode?: boolean
  computerUse?: boolean
  authMode?: 'strict' | 'auto'
  skillIds?: string[]
}

export interface WorkSuggestion {
  id: string
  layer: SuggestionLayer
  /** Knowledge cards use the fixed type `'knowledge'`; their origin lives in `knowledge`. */
  type: SuggestionType | 'weekly-theme' | 'knowledge'
  /** Literal text for `source: 'llm'`; an i18n key for `source: 'static'`. */
  title: string
  description?: string
  prompt: string
  scene?: SuggestionScene
  sendMode: SuggestionSendMode
  source: 'llm' | 'static'
  featureTag?: SuggestionFeatureTag
  knowledge?: KnowledgeMeta
  generatedAt: string
  validUntil: string
  /** Set on the first delivery of a daily item so the UI can show a "new" badge. */
  fresh?: boolean
}

export type DailySuggestionBatchStatus = 'ok' | 'partial' | 'failed'

export interface DailySuggestionBatch {
  /** Local calendar date, `YYYY-MM-DD`. One batch per day; regenerate replaces it. */
  date: string
  status: DailySuggestionBatchStatus
  items: WorkSuggestion[]
  generatedAt: string
  error?: string
  manualRefreshCount: number
  providerId?: string | null
  modelId?: string | null
}

export interface DailySuggestionGenerationState {
  date: string
  at: string
  status: DailySuggestionBatchStatus
  error?: string
  manualRefreshCount: number
  manualRefreshLimit: number
}

export interface DailySuggestionSnapshot {
  preferences: DailySuggestionPreferences
  /** Today's LLM items, dismissed ones removed. Empty when the feature is off. */
  daily: WorkSuggestion[]
  /** The weekly capability pool, dismissed ones removed. */
  explore: WorkSuggestion[]
  /** Today's knowledge hooks (random seed first), dismissed ones removed. Empty when off. */
  knowledge: WorkSuggestion[]
  /** How many times the random seed can still be swapped today. */
  knowledgeShuffleRemaining: number
  /** i18n key suffix of this week's theme, e.g. `automation`. */
  weekTheme: string
  lastGeneration: DailySuggestionGenerationState | null
  generating: boolean
  /** Set when the last generation could not run because no provider is configured. */
  providerMissing: boolean
}

export const DAILY_SUGGESTION_MANUAL_REFRESH_LIMIT = 3

export const DEFAULT_DAILY_SUGGESTION_PREFERENCES: DailySuggestionPreferences = {
  enabled: false,
  types: ['new-idea', 'improve-project', 'feature-tip'],
  countPerType: 3,
  trigger: { kind: 'first-open' },
  providerId: null,
  modelId: null,
  context: {
    projects: true,
    conversationTitles: true,
    conversationSummaries: false
  },
  knowledge: {
    enabled: true,
    sources: ['random'],
    interests: [],
    profession: '',
    countPerSource: 1
  }
}

export function isKnowledgeSource (value: unknown): value is KnowledgeSource {
  return typeof value === 'string' && (KNOWLEDGE_SOURCES as readonly string[]).includes(value)
}

function clipText (value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

export function normalizeKnowledgePreferences (value: unknown): KnowledgePreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const defaults = DEFAULT_DAILY_SUGGESTION_PREFERENCES.knowledge

  const sources = Array.isArray(input.sources)
    ? KNOWLEDGE_SOURCES.filter(source => (input.sources as unknown[]).includes(source))
    : [...defaults.sources]

  const interests: string[] = []
  if (Array.isArray(input.interests)) {
    const seen = new Set<string>()
    for (const raw of input.interests) {
      const next = clipText(raw, KNOWLEDGE_INTEREST_MAX_LENGTH)
      const key = next.toLowerCase()
      if (!next || seen.has(key)) continue
      seen.add(key)
      interests.push(next)
      if (interests.length >= KNOWLEDGE_MAX_INTERESTS) break
    }
  }

  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    sources: sources.length > 0 ? sources : [...defaults.sources],
    interests,
    profession: clipText(input.profession, KNOWLEDGE_PROFESSION_MAX_LENGTH),
    countPerSource: input.countPerSource === 2 ? 2 : 1
  }
}

function normalizeTimeOfDay (value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function isSuggestionType (value: unknown): value is SuggestionType {
  return typeof value === 'string' && (SUGGESTION_TYPES as readonly string[]).includes(value)
}

/**
 * Coerce any persisted or IPC-provided value into a valid preference object.
 * Shared by the main-process store and the renderer so both sides agree on
 * defaults. Empty `types` falls back to the default selection so a generation
 * can never run with nothing to generate.
 */
export function normalizeDailySuggestionPreferences (value: unknown): DailySuggestionPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const defaults = DEFAULT_DAILY_SUGGESTION_PREFERENCES

  const types = Array.isArray(input.types)
    ? Array.from(new Set(input.types.filter(isSuggestionType)))
    : [...defaults.types]

  const countPerType: DailySuggestionCountPerType = input.countPerType === 2 || input.countPerType === 5
    ? input.countPerType
    : 3

  let trigger: DailySuggestionTrigger = { ...defaults.trigger }
  const rawTrigger = input.trigger && typeof input.trigger === 'object' ? input.trigger as Record<string, unknown> : null
  if (rawTrigger?.kind === 'time') {
    trigger = { kind: 'time', timeOfDay: normalizeTimeOfDay(rawTrigger.timeOfDay) || '09:00' }
  } else if (rawTrigger?.kind === 'first-open') {
    trigger = { kind: 'first-open' }
  }

  const rawContext = input.context && typeof input.context === 'object' ? input.context as Record<string, unknown> : {}
  const context: DailySuggestionContextScope = {
    projects: typeof rawContext.projects === 'boolean' ? rawContext.projects : defaults.context.projects,
    conversationTitles: typeof rawContext.conversationTitles === 'boolean' ? rawContext.conversationTitles : defaults.context.conversationTitles,
    conversationSummaries: typeof rawContext.conversationSummaries === 'boolean' ? rawContext.conversationSummaries : defaults.context.conversationSummaries
  }

  return {
    enabled: input.enabled === true,
    types: types.length > 0 ? types : [...defaults.types],
    countPerType,
    trigger,
    providerId: typeof input.providerId === 'string' && input.providerId.trim() ? input.providerId.trim() : null,
    modelId: typeof input.modelId === 'string' && input.modelId.trim() ? input.modelId.trim() : null,
    context,
    knowledge: normalizeKnowledgePreferences(input.knowledge)
  }
}

/** Local calendar date as `YYYY-MM-DD` (never UTC, so "today" matches the user's clock). */
export function formatLocalDate (date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
