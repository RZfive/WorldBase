import crypto from 'node:crypto'
import type { AIConfigInput } from '../ai-engine/engine-contracts.js'
import type { AIExecutionEngine } from '../ai-harness/types.js'
import type { DailySuggestionStore } from '../settings/daily-suggestion-store.js'
import {
  LLM_KNOWLEDGE_SOURCES,
  formatLocalDate,
  isKnowledgeSource,
  isSuggestionType,
  normalizeDailySuggestionPreferences,
  type DailySuggestionBatch,
  type DailySuggestionBatchStatus,
  type DailySuggestionPreferences,
  type DailySuggestionSnapshot,
  type KnowledgePoolState,
  type KnowledgePreferences,
  type KnowledgeSource,
  type SuggestionScene,
  type SuggestionType,
  type WorkSuggestion
} from '../../shared/daily-suggestion-types.js'
import { buildExploreSuggestions, staticFallbacksForType } from './static-suggestions.js'
import {
  GENERATED_SEED_ID_PREFIX,
  KNOWLEDGE_CARD_ID_PREFIX,
  KNOWLEDGE_DISCIPLINES,
  KNOWLEDGE_SEEDS,
  KNOWLEDGE_STATIC_ID_PREFIX,
  buildKnowledgeCardSuggestion,
  buildKnowledgePool,
  buildKnowledgeSeedSuggestion,
  countUnseenKnowledgeCards,
  countUnseenSeeds,
  drawKnowledgeSeed,
  drawableKnowledgeCards,
  findKnowledgeSeed,
  hashString,
  isKnowledgeDiscipline,
  pickRotated,
  titleKey,
  type GeneratedKnowledgeCard,
  type GeneratedKnowledgeSeed,
  type KnowledgeSeed
} from './knowledge-seeds.js'

export interface SuggestionProjectContext {
  id: string
  name: string
  type: string
  status?: string
  port?: number
}

export interface SuggestionConversationContext {
  title: string
  updatedAt: string
  previewText?: string
}

export interface SuggestionCapabilityContext {
  skillNames: string[]
  mcpServerNames: string[]
  scheduledTaskCount: number
  longTermGoalCount: number
  agentGroupCount: number
}

export interface DailySuggestionServiceOptions {
  store: DailySuggestionStore
  resolveAiEngine: () => Promise<AIExecutionEngine>
  resolveProviderConfig: (providerId?: string | null, modelId?: string | null) => AIConfigInput | undefined
  listProjects: () => Promise<SuggestionProjectContext[]>
  listConversations: () => Promise<SuggestionConversationContext[]>
  getCapabilities: () => Promise<SuggestionCapabilityContext>
  /** UI locale tag such as `zh-CN`; the model writes suggestions in this language. */
  getLocale: () => string
  onChanged?: (snapshot: DailySuggestionSnapshot) => void
  /** Overridable for tests. */
  now?: () => Date
}

/** A tool name that matches nothing, so both harnesses run a plain completion. */
const NO_TOOLS_SENTINEL = '__daily_suggestions_no_tools__'
const MAX_CONVERSATIONS_IN_CONTEXT = 20
const MAX_PROJECTS_IN_CONTEXT = 20
const TITLE_MAX_LENGTH = 40
const DESCRIPTION_MAX_LENGTH = 120
const PROMPT_MAX_LENGTH = 800
const RESCHEDULE_CHECK_INTERVAL_MS = 15 * 60 * 1000
/** A failed batch is reused for at most this many days before the daily group goes quiet. */
const STALE_BATCH_MAX_AGE_DAYS = 3

/**
 * Pool replenishment. Both pools (random seeds and LLM-source cards) are
 * topped up from the model in batches so refreshing never runs dry: a top-up
 * runs when a pool has been 80% consumed, when it has few entries left
 * outside the reuse window, or at least weekly. A failed attempt backs off
 * until the next day (or until a refresh drains a pool again) so a broken
 * provider does not retry on every check.
 */
export const KNOWLEDGE_REPLENISH_BATCH = 12
export const KNOWLEDGE_REPLENISH_MIN_UNSEEN = 12
export const KNOWLEDGE_REPLENISH_INTERVAL_DAYS = 7
/** A pool at or above this consumed fraction triggers the next batch right away. */
export const KNOWLEDGE_POOL_REPLENISH_THRESHOLD = 0.8
/** Cards written per selected LLM knowledge source in one card-pool batch. */
export const KNOWLEDGE_CARD_REPLENISH_BATCH = 4
const GENERATED_SEED_SLUG_MAX = 48

const TYPE_INSTRUCTIONS: Record<SuggestionType, string> = {
  'new-idea': 'Propose a concrete new project the user could start today, matched to the technology and domains visible in their context. The prompt must ask the assistant to scaffold or plan that project.',
  'improve-project': 'Propose a specific improvement to one of the listed projects (name it). The prompt must reference that project by name and describe the change to make.',
  'learn-question': 'Ask a reflective or technical question that helps the user think about their recent work, then have the prompt ask the assistant to explore that question together with the user.',
  automation: 'Suggest something recurring or long-running that the user could hand to a scheduled task, a long-term goal, or an agent group. The prompt must ask the assistant to set that automation up.',
  'feature-tip': 'Teach one product capability the user seems not to have used yet (plan mode, computer use, skills, MCP servers, scheduled tasks, long-term goals, agent groups, document workspace, folder workspace, web search). The prompt must exercise that capability.',
  'data-insight': 'Suggest a data question worth answering about one of the listed projects (name it). The prompt must ask the assistant to inspect that project\'s data and report findings.'
}

/**
 * Knowledge cards are curiosity hooks, not tasks: the title is a question or a
 * counter-intuitive fact, and relevance to the user's work is a bonus rather
 * than a requirement.
 */
const KNOWLEDGE_SOURCE_INSTRUCTIONS: Record<Exclude<KnowledgeSource, 'random'>, string> = {
  'cross-discipline': 'Pick one intriguing concept, phenomenon or historical episode from a discipline DIFFERENT from the user\'s work (never software engineering itself). The title must be a question or a counter-intuitive fact. It does not have to relate to the user\'s work; if a natural link exists, mention it in the description in one clause, but never force one.',
  'work-domain': 'Infer the user\'s field from their projects, conversation titles and profession, then pick a concept, principle or piece of lore from that field the user has most likely never dug into. Curiosity first; it need not be immediately applicable.',
  interest: 'Stay strictly within one of the user\'s declared interests and offer an entry point that is accessible but not shallow, one that invites a chain of follow-up questions.'
}

const KNOWLEDGE_DISCIPLINE_MAX_LENGTH = 20

/**
 * Model-output guards for knowledge copy. Weaker models occasionally echo the
 * prompt template verbatim — literal `X` placeholder included — or answer in
 * English for a non-English locale. Either way the prompt the user sends is
 * broken, so such items are rejected instead of shown. `X` only counts as a
 * placeholder when it stands alone (a quoted `「X」`, `about X.`) so real
 * terms like X-rays or X光 are untouched.
 */
const PROMPT_PLACEHOLDER_PATTERN = /curious about\s+X(?![A-Za-z-])|[{「『"'（(]X(?![\p{L}\p{N}-])[}」』"'）)]|(?:关于|对)X(?![\p{L}\p{N}-])/u

/** True when the copy still contains a template placeholder or is in the wrong language. */
export function knowledgeCopyLooksBroken (locale: string, title: string, prompt: string): boolean {
  if (PROMPT_PLACEHOLDER_PATTERN.test(title) || PROMPT_PLACEHOLDER_PATTERN.test(prompt)) return true
  const combined = `${title}\n${prompt}`
  if (/^zh/i.test(locale)) return !/[\u4e00-\u9fff]/.test(combined)
  if (/^ja/i.test(locale)) return !/[\u3040-\u30ff\u4e00-\u9fff]/.test(combined)
  if (/^ko/i.test(locale)) return !/[\uac00-\ud7af]/.test(combined)
  return !/[A-Za-z]/.test(combined)
}

function clip (value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

function daysBetween (a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const start = Date.UTC(ay, am - 1, ad)
  const end = Date.UTC(by, bm - 1, bd)
  return Math.round((end - start) / 86400000)
}

/** Pull the first JSON array out of a model reply that may be wrapped in prose or a code fence. */
export function extractJsonArray (text: string): unknown[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fenced?.[1], text]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.indexOf('[')
    const end = candidate.lastIndexOf(']')
    if (start < 0 || end <= start) continue
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    } catch {
      // try the next candidate
    }
  }
  return null
}

function normalizeScene (value: unknown, projectIds: Set<string>): SuggestionScene | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const scene: SuggestionScene = {}
  if (typeof raw.targetProjectId === 'string' && projectIds.has(raw.targetProjectId)) scene.targetProjectId = raw.targetProjectId
  if (raw.planMode === true) scene.planMode = true
  if (raw.computerUse === true) scene.computerUse = true
  if (raw.authMode === 'strict' || raw.authMode === 'auto') scene.authMode = raw.authMode
  return Object.keys(scene).length > 0 ? scene : undefined
}

/**
 * Validate one model-emitted item. Anything outside the user's selected types
 * is dropped, so the model cannot widen the scope the user agreed to.
 */
export function normalizeLlmSuggestion (
  value: unknown,
  allowedTypes: ReadonlySet<SuggestionType>,
  projectIds: Set<string>,
  now: Date
): WorkSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isSuggestionType(raw.type) || !allowedTypes.has(raw.type)) return null
  const title = typeof raw.title === 'string' ? clip(raw.title, TITLE_MAX_LENGTH) : ''
  const prompt = typeof raw.prompt === 'string' ? clip(raw.prompt, PROMPT_MAX_LENGTH) : ''
  if (!title || !prompt) return null
  const description = typeof raw.description === 'string' ? clip(raw.description, DESCRIPTION_MAX_LENGTH) : ''
  const validUntil = new Date(now)
  validUntil.setHours(23, 59, 59, 999)
  return {
    id: `llm:${formatLocalDate(now)}:${crypto.randomUUID()}`,
    layer: 'daily',
    type: raw.type,
    title,
    description: description || undefined,
    prompt,
    scene: normalizeScene(raw.scene, projectIds),
    sendMode: 'fill',
    source: 'llm',
    generatedAt: now.toISOString(),
    validUntil: validUntil.toISOString(),
    fresh: true
  }
}

/**
 * Validate one model-emitted knowledge item. Sources outside the user's
 * selection are dropped, `interest` needs at least one declared interest,
 * template placeholders and wrong-language copy are rejected, and any scene
 * is ignored: knowledge cards start a conversation, not a task.
 */
export function normalizeKnowledgeSuggestion (
  value: unknown,
  preferences: KnowledgePreferences,
  now: Date,
  locale: string
): WorkSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isKnowledgeSource(raw.source) || raw.source === 'random' || !preferences.sources.includes(raw.source)) return null
  if (raw.source === 'interest' && preferences.interests.length === 0) return null
  const title = typeof raw.title === 'string' ? clip(raw.title, TITLE_MAX_LENGTH) : ''
  const prompt = typeof raw.prompt === 'string' ? clip(raw.prompt, PROMPT_MAX_LENGTH) : ''
  if (!title || !prompt) return null
  if (knowledgeCopyLooksBroken(locale, title, prompt)) return null
  const description = typeof raw.description === 'string' ? clip(raw.description, DESCRIPTION_MAX_LENGTH) : ''
  const discipline = typeof raw.discipline === 'string' ? clip(raw.discipline, KNOWLEDGE_DISCIPLINE_MAX_LENGTH) : ''
  const validUntil = new Date(now)
  validUntil.setHours(23, 59, 59, 999)
  return {
    id: `llm:${formatLocalDate(now)}:${crypto.randomUUID()}`,
    layer: 'knowledge',
    type: 'knowledge',
    title,
    description: description || undefined,
    prompt,
    sendMode: 'fill',
    source: 'llm',
    knowledge: { source: raw.source, discipline: discipline || undefined },
    generatedAt: now.toISOString(),
    validUntil: validUntil.toISOString(),
    fresh: true
  }
}

/**
 * Turn an already validated knowledge item into a pool card so future draws
 * and single-card refreshes can hand it out again without a model call.
 */
export function knowledgeCardFromSuggestion (item: WorkSuggestion, locale: string, existingTitles: Set<string>): GeneratedKnowledgeCard | null {
  const source = item.knowledge?.source
  if (!source || source === 'random') return null
  const key = `${source}|${locale}|${titleKey(item.title)}`
  if (existingTitles.has(key)) return null
  existingTitles.add(key)
  return {
    id: `kc-${crypto.randomUUID().slice(0, 8)}`,
    source,
    discipline: item.knowledge?.discipline,
    copy: {
      locale,
      title: item.title,
      description: item.description || '',
      prompt: item.prompt,
      createdAt: item.generatedAt
    }
  }
}

/**
 * Validate one model-emitted card for the LLM-source pool. Same rules as
 * `normalizeKnowledgeSuggestion`; titles dedupe against `existingTitles`,
 * which is extended in place so one reply cannot repeat itself.
 */
export function normalizeGeneratedKnowledgeCard (
  raw: unknown,
  preferences: KnowledgePreferences,
  locale: string,
  now: Date,
  existingTitles: Set<string>
): GeneratedKnowledgeCard | null {
  const suggestion = normalizeKnowledgeSuggestion(raw, preferences, now, locale)
  if (!suggestion) return null
  const key = `${suggestion.knowledge!.source}|${locale}|${titleKey(suggestion.title)}`
  if (existingTitles.has(key)) return null
  existingTitles.add(key)
  return {
    id: `kc-${crypto.randomUUID().slice(0, 8)}`,
    source: suggestion.knowledge!.source as Exclude<KnowledgeSource, 'random'>,
    discipline: suggestion.knowledge!.discipline,
    copy: {
      locale,
      title: suggestion.title,
      description: suggestion.description || '',
      prompt: suggestion.prompt,
      createdAt: now.toISOString()
    }
  }
}

/** Whether the knowledge group needs a model call under these preferences. */
export function knowledgeNeedsModel (preferences: DailySuggestionPreferences): boolean {
  return preferences.knowledge.enabled && preferences.knowledge.sources.some(source => (LLM_KNOWLEDGE_SOURCES as readonly string[]).includes(source))
}

/** Whether the random seed pool is in use, which is what replenishment serves. */
export function knowledgeUsesRandomPool (preferences: DailySuggestionPreferences): boolean {
  return preferences.knowledge.enabled && preferences.knowledge.sources.includes('random')
}

function slugify (value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, GENERATED_SEED_SLUG_MAX)
    .replace(/-+$/g, '')
}

/** A dismissed suggestion id (`kcard:<date>:<cardId>`) or a bare card id → card id. */
function toCardId (suggestionId: string): string {
  return suggestionId.startsWith(KNOWLEDGE_CARD_ID_PREFIX) ? suggestionId.split(':')[2] || '' : suggestionId
}

/**
 * Validate one model-emitted seed for the random pool. The id is derived from
 * the model's English slug so duplicates across runs collapse regardless of
 * locale; a slug that collides with a built-in id or an existing generated
 * seed is dropped. `existingIds` and `existingTitles` are extended in place so
 * a single reply cannot contain the same topic twice.
 */
export function normalizeGeneratedSeed (
  raw: unknown,
  locale: string,
  now: Date,
  existingIds: Set<string>,
  existingTitles: Set<string>
): GeneratedKnowledgeSeed | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  if (!isKnowledgeDiscipline(item.discipline)) return null
  const slug = typeof item.slug === 'string' ? slugify(item.slug) : ''
  if (slug.length < 3) return null
  const id = `${GENERATED_SEED_ID_PREFIX}${slug}`
  if (existingIds.has(id) || existingIds.has(slug)) return null
  const title = typeof item.title === 'string' ? clip(item.title, TITLE_MAX_LENGTH) : ''
  const description = typeof item.description === 'string' ? clip(item.description, DESCRIPTION_MAX_LENGTH) : ''
  const prompt = typeof item.prompt === 'string' ? clip(item.prompt, PROMPT_MAX_LENGTH) : ''
  if (!title || !prompt) return null
  if (knowledgeCopyLooksBroken(locale, title, prompt)) return null
  const key = titleKey(title)
  if (!key || existingTitles.has(key)) return null
  existingIds.add(id)
  existingTitles.add(key)
  return {
    id,
    discipline: item.discipline,
    copy: { locale, title, description, prompt, createdAt: now.toISOString() }
  }
}

export class DailySuggestionService {
  private readonly options: DailySuggestionServiceOptions
  private timer: ReturnType<typeof setTimeout> | null = null
  private checkInterval: ReturnType<typeof setInterval> | null = null
  private generating: Promise<DailySuggestionBatch | null> | null = null
  private replenishing: Promise<number> | null = null
  private providerMissing = false
  private disposed = false

  constructor (options: DailySuggestionServiceOptions) {
    this.options = options
  }

  private now (): Date {
    return this.options.now ? this.options.now() : new Date()
  }

  start (): void {
    this.disposed = false
    this.reschedule()
    this.checkInterval = setInterval(() => {
      this.reschedule()
      void this.maybeReplenishKnowledgePool()
    }, RESCHEDULE_CHECK_INTERVAL_MS)
    void this.runIfDue('startup')
    void this.maybeReplenishKnowledgePool()
  }

  dispose (): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.checkInterval) clearInterval(this.checkInterval)
    this.checkInterval = null
  }

  getPreferences (): DailySuggestionPreferences {
    return this.options.store.getPreferences()
  }

  savePreferences (input: unknown): DailySuggestionPreferences {
    const previous = this.options.store.getPreferences()
    const next = this.options.store.savePreferences(normalizeDailySuggestionPreferences(input))
    this.reschedule()
    this.emitChanged()
    // Turning a model-backed group on should show something today, not tomorrow.
    const wasActive = previous.enabled || knowledgeNeedsModel(previous)
    const isActive = next.enabled || knowledgeNeedsModel(next)
    const knowledgeScopeGrew = knowledgeNeedsModel(next) && (
      !knowledgeNeedsModel(previous)
      || next.knowledge.sources.some(source => !previous.knowledge.sources.includes(source))
      || (next.knowledge.interests.length > 0 && previous.knowledge.interests.length === 0)
    )
    if ((isActive && !wasActive) || (next.enabled && !previous.enabled) || knowledgeScopeGrew) {
      void this.runIfDue('enable')
    }
    if (knowledgeUsesRandomPool(next) && !knowledgeUsesRandomPool(previous)) {
      void this.maybeReplenishKnowledgePool()
    }
    return next
  }

  getSnapshot (): DailySuggestionSnapshot {
    const now = this.now()
    const preferences = this.options.store.getPreferences()
    const dismissed = this.options.store.getDismissedIds()
    const explore = buildExploreSuggestions(now)
    const batch = this.ensureKnowledgeBatchFromPool(preferences, now)
    const knowledge: WorkSuggestion[] = []
    if (preferences.knowledge.enabled) {
      if (preferences.knowledge.sources.includes('random')) {
        const seed = this.resolveRandomSeed(now)
        const card = buildKnowledgeSeedSuggestion(seed, now)
        if (!dismissed.has(card.id)) knowledge.push(card)
        const randomDiscipline = seed.discipline
        const llmItems = (batch?.items || []).filter(item => item.layer === 'knowledge' && !dismissed.has(item.id))
        // Items sharing the random card's discipline read as repeats; push them to the back.
        llmItems.sort((a, b) => Number(a.knowledge?.discipline === randomDiscipline) - Number(b.knowledge?.discipline === randomDiscipline))
        knowledge.push(...llmItems)
      } else {
        knowledge.push(...(batch?.items || []).filter(item => item.layer === 'knowledge' && !dismissed.has(item.id)))
      }
    }
    return {
      preferences,
      daily: preferences.enabled && batch ? batch.items.filter(item => item.layer === 'daily' && !dismissed.has(item.id)) : [],
      explore: explore.items.filter(item => !dismissed.has(item.id)),
      knowledge,
      knowledgePool: this.knowledgePoolState(formatLocalDate(now)),
      weekTheme: explore.theme,
      lastGeneration: batch
        ? {
            date: batch.date,
            at: batch.generatedAt,
            status: batch.status,
            error: batch.error,
            manualRefreshCount: batch.manualRefreshCount
          }
        : null,
      generating: this.generating !== null,
      providerMissing: this.providerMissing
    }
  }

  /**
   * A daily batch can predate its card pool top-up: the model-backed knowledge
   * request may finish empty while the background pool replenish succeeds later.
   * When the displayed day is missing selected sources, draw the shortfall from
   * cards that are already local (no provider/model call), then persist it into
   * today's batch so repeated snapshots stay stable.
   */
  private ensureKnowledgeBatchFromPool (
    preferences: DailySuggestionPreferences,
    now: Date
  ): DailySuggestionBatch | null {
    const batch = this.resolveDisplayBatch(preferences, now)
    if (!preferences.knowledge.enabled) return batch

    const today = formatLocalDate(now)
    const todays = this.options.store.getBatch(today)
    if (!todays || todays.status === 'failed') return batch

    const sources = this.selectedKnowledgeLlmSources(preferences)
    if (sources.length === 0) return batch

    const existingKnowledge = todays.items.filter(item => item.layer === 'knowledge')
    const counts = new Map<KnowledgeSource, number>()
    for (const item of existingKnowledge) {
      const source = item.knowledge?.source
      if (!source) continue
      counts.set(source, (counts.get(source) || 0) + 1)
    }
    const missing = sources.filter(source => (counts.get(source) || 0) < preferences.knowledge.countPerSource)
    if (missing.length === 0) return batch

    const excluded = new Set(this.options.store.getDismissedIds())
    for (const item of existingKnowledge) {
      if (item.knowledge?.seedId) excluded.add(item.id)
    }
    const cursor = this.options.store.getKnowledgeCardCursor()
    const cards = this.knowledgeCardPool()
    if (cards.length === 0) return batch

    const salt = this.options.store.getKnowledgeSalt()
    const history = this.options.store.getKnowledgeSeedHistory()
    const excludedCardIds = new Set([...excluded].map(toCardId))
    const wantedCounts = new Map(missing.map(source => [
      source,
      preferences.knowledge.countPerSource - (counts.get(source) || 0)
    ]))
    const drawn = this.drawPoolKnowledgeItems(preferences, now, excluded, cursor, wantedCounts)
    if (drawn.length === 0) return batch

    this.options.store.saveBatch({ ...todays, items: [...todays.items, ...drawn] })
    const drawnIds = drawn
      .map(item => item.knowledge?.seedId)
      .filter((id): id is string => !!id)
    this.options.store.recordKnowledgeShown(today, drawnIds)
    return this.options.store.getBatch(today) || batch
  }

  dismiss (suggestionId: string): DailySuggestionSnapshot {
    const item = this.findSuggestion(suggestionId)
    const type = item && isSuggestionType(item.type) ? item.type : undefined
    this.options.store.dismiss(suggestionId, type, item?.knowledge?.source)
    const snapshot = this.getSnapshot()
    this.options.onChanged?.(snapshot)
    return snapshot
  }

  /** Called when a card is used, so dismissal streaks reflect real interest. */
  recordPick (suggestionId: string): void {
    const item = this.findSuggestion(suggestionId)
    if (!item) return
    const type = isSuggestionType(item.type) ? item.type : undefined
    if (type || item.knowledge) this.options.store.recordPick(type, item.knowledge?.source)
    if (item.fresh) this.clearFreshFlag(item.id)
  }

  /**
   * Swap today's random knowledge seed for another one. Unlimited; a drained
   * pool schedules the next replenishment batch.
   */
  shuffleKnowledge (): DailySuggestionSnapshot {
    const now = this.now()
    const today = formatLocalDate(now)
    const preferences = this.options.store.getPreferences()
    if (!preferences.knowledge.enabled || !preferences.knowledge.sources.includes('random')) {
      throw new Error('KNOWLEDGE_RANDOM_DISABLED')
    }
    const current = this.options.store.getKnowledgeToday(today)
    const history = this.options.store.getKnowledgeSeedHistory()
    const salt = this.options.store.getKnowledgeSalt()
    const pool = this.knowledgePool()
    let next: KnowledgeSeed | null = null
    // Attempts are deterministic; walk forward until the draw lands on a different seed.
    for (let attempt = 0; attempt <= 80 && !next; attempt++) {
      const candidate = drawKnowledgeSeed(today, salt, history, attempt, pool)
      if (candidate.id !== current?.seedId) next = candidate
    }
    if (!next) throw new Error('KNOWLEDGE_POOL_EXHAUSTED')
    this.options.store.setKnowledgeToday(today, next.id, true)
    const snapshot = this.getSnapshot()
    this.options.onChanged?.(snapshot)
    // Heavy shuffling may have crossed the pool's replenishment threshold.
    void this.maybeReplenishKnowledgePool()
    return snapshot
  }

  /** Marks today's items as seen so the "new" badge shows once. */
  markSeen (): void {
    const batch = this.options.store.getBatch(formatLocalDate(this.now()))
    if (!batch || !batch.items.some(item => item.fresh)) return
    this.options.store.saveBatch({ ...batch, items: batch.items.map(item => ({ ...item, fresh: false })) })
  }

  /**
   * User-initiated regeneration. Unlimited: the daily group is regenerated
   * from the model and the knowledge group is re-drawn from the pool.
   */
  async generateNow (): Promise<DailySuggestionSnapshot> {
    const preferences = this.options.store.getPreferences()
    if (!preferences.enabled && !knowledgeNeedsModel(preferences)) throw new Error('DAILY_SUGGESTIONS_DISABLED')
    await this.generate({ manual: true })
    return this.getSnapshot()
  }

  /**
   * Swap one knowledge card for the next pool entry of its source. Unlimited
   * like the group refresh; the random seed goes through the same draw as the
   * shuffle tool. Backed by the settings-page previews and the ↻ tool on
   * every knowledge card.
   */
  async refreshKnowledgeCard (suggestionId: string): Promise<DailySuggestionSnapshot> {
    const now = this.now()
    const today = formatLocalDate(now)
    const preferences = this.options.store.getPreferences()
    if (!preferences.knowledge.enabled) throw new Error('KNOWLEDGE_RANDOM_DISABLED')
    const item = this.findSuggestion(suggestionId)
    if (!item || item.layer !== 'knowledge' || !item.knowledge) throw new Error('KNOWLEDGE_CARD_NOT_FOUND')
    if (item.knowledge.source === 'random') return this.shuffleKnowledge()
    const excludedCardIds = new Set<string>([...this.options.store.getDismissedIds()].map(toCardId))
    if (item.knowledge.seedId) excludedCardIds.add(item.knowledge.seedId)
    let replacement = this.drawSinglePoolCard(preferences, item.knowledge.source, now, excludedCardIds)
    if (!replacement) {
      // This source's slice of the pool is drained: write the next batch, then try once more.
      await this.replenishKnowledgePool()
      this.options.store.bumpKnowledgeCardCursor()
      replacement = this.drawSinglePoolCard(preferences, item.knowledge.source, now, excludedCardIds)
    }
    if (!replacement) throw new Error('KNOWLEDGE_POOL_EXHAUSTED')
    this.options.store.recordKnowledgeShown(today, [replacement.id])
    this.options.store.bumpKnowledgeCardCursor()
    const nextItem = buildKnowledgeCardSuggestion(replacement, now)
    const batch = this.options.store.getBatch(today)
    const batchItems = batch?.items || []
    this.options.store.saveBatch({
      date: today,
      status: batch && batch.status !== 'failed' ? batch.status : 'ok',
      items: batchItems.some(existing => existing.id === item.id)
        ? batchItems.map(existing => existing.id === item.id ? nextItem : existing)
        : [...batchItems, nextItem],
      generatedAt: batch?.generatedAt || now.toISOString(),
      manualRefreshCount: batch?.manualRefreshCount || 0
    })
    const snapshot = this.getSnapshot()
    this.options.onChanged?.(snapshot)
    void this.maybeReplenishKnowledgePool()
    return snapshot
  }

  /** Today's random seed, drawing and pinning one on the first call of the day. */
  private resolveRandomSeed (now: Date): KnowledgeSeed {
    const today = formatLocalDate(now)
    const pinned = this.options.store.getKnowledgeToday(today)
    // Any locale: a seed pinned before a language switch stays for the day.
    const existing = pinned ? findKnowledgeSeed(pinned.seedId, this.options.store.getGeneratedSeeds()) : undefined
    if (existing) return existing
    const seed = drawKnowledgeSeed(today, this.options.store.getKnowledgeSalt(), this.options.store.getKnowledgeSeedHistory(), 0, this.knowledgePool())
    this.options.store.setKnowledgeToday(today, seed.id, false)
    return seed
  }

  /** Built-in seeds plus generated seeds written for the current UI locale. */
  private knowledgePool (): KnowledgeSeed[] {
    return buildKnowledgePool(this.options.store.getGeneratedSeeds(), this.options.getLocale())
  }

  /** The LLM-source card pool for the current UI locale. */
  private knowledgeCardPool (): GeneratedKnowledgeCard[] {
    return this.options.store.getKnowledgeCards().filter(card => card.copy.locale === this.options.getLocale())
  }

  /** The selected model-backed knowledge sources, in preference order. */
  private selectedKnowledgeLlmSources (preferences: DailySuggestionPreferences): Exclude<KnowledgeSource, 'random'>[] {
    return preferences.knowledge.sources.filter((source): source is Exclude<KnowledgeSource, 'random'> =>
      source !== 'random' && (source !== 'interest' || preferences.knowledge.interests.length > 0)
    )
  }

  private knowledgePoolState (today: string): KnowledgePoolState {
    const pool = this.knowledgePool()
    const cards = this.knowledgeCardPool()
    const history = this.options.store.getKnowledgeSeedHistory()
    const replenish = this.options.store.getKnowledgeReplenish()
    return {
      builtin: KNOWLEDGE_SEEDS.length,
      generated: pool.length - KNOWLEDGE_SEEDS.length,
      unseen: countUnseenSeeds(pool, today, history),
      cards: cards.length,
      cardsUnseen: countUnseenKnowledgeCards(cards, today, history),
      lastReplenishAt: replenish.lastSuccessAt || null,
      lastReplenishError: replenish.lastError || null,
      replenishing: this.replenishing !== null
    }
  }

  /** Fraction of a pool already shown within the reuse window; ≥ 80% drains it. */
  private poolConsumedFraction (total: number, unseen: number): number {
    if (total <= 0) return 0
    return 1 - unseen / total
  }

  /**
   * Draw the next knowledge hand from the card pool: per selected source,
   * `countPerSource` cards starting at a (date, salt, source, cursor) offset,
   * skipping whatever was shown recently or dismissed today.
   */
  private drawPoolKnowledgeItems (
    preferences: DailySuggestionPreferences,
    now: Date,
    excludeSuggestionIds: ReadonlySet<string>,
    cursor: number,
    sourceCounts?: ReadonlyMap<KnowledgeSource, number>
  ): WorkSuggestion[] {
    const sources = this.selectedKnowledgeLlmSources(preferences)
    const cards = this.knowledgeCardPool()
    if (sources.length === 0 || cards.length === 0) return []
    const today = formatLocalDate(now)
    const salt = this.options.store.getKnowledgeSalt()
    const history = this.options.store.getKnowledgeSeedHistory()
    const excludedCardIds = new Set([...excludeSuggestionIds].map(toCardId))
    const drawn: WorkSuggestion[] = []
    for (const source of sources) {
      const wanted = sourceCounts?.get(source) ?? preferences.knowledge.countPerSource
      if (wanted <= 0) continue
      const candidates = drawableKnowledgeCards(cards, source, today, history, excludedCardIds)
      const start = hashString(`${today}|${salt}|${source}|${cursor}`)
      for (const card of pickRotated(candidates, start, wanted)) {
        drawn.push(buildKnowledgeCardSuggestion(card, now))
      }
    }
    return drawn
  }

  /** One replacement card for a single-card refresh. */
  private drawSinglePoolCard (
    preferences: DailySuggestionPreferences,
    source: Exclude<KnowledgeSource, 'random'>,
    now: Date,
    excludedCardIds: ReadonlySet<string>
  ): GeneratedKnowledgeCard | null {
    const cards = this.knowledgeCardPool()
    if (cards.length === 0) return null
    const today = formatLocalDate(now)
    const salt = this.options.store.getKnowledgeSalt()
    const history = this.options.store.getKnowledgeSeedHistory()
    const candidates = drawableKnowledgeCards(cards, source, today, history, excludedCardIds)
    if (candidates.length === 0) return null
    const cursor = this.options.store.getKnowledgeCardCursor()
    const start = hashString(`${today}|${salt}|${source}|${cursor}`)
    return pickRotated(candidates, start, 1)[0]
  }

  /**
   * Top a pool up when it is drained (80% consumed), running low, or stale.
   * Silent on every precondition (pool unused, no provider, backed off today)
   * so callers can fire it from any check without guarding.
   */
  private async maybeReplenishKnowledgePool (): Promise<void> {
    if (this.disposed) return
    const preferences = this.options.store.getPreferences()
    const randomOn = knowledgeUsesRandomPool(preferences)
    const llmOn = knowledgeNeedsModel(preferences)
    if (!randomOn && !llmOn) return
    const today = formatLocalDate(this.now())
    const replenish = this.options.store.getKnowledgeReplenish()
    const stale = !replenish.lastSuccessAt || daysBetween(formatLocalDate(new Date(replenish.lastSuccessAt)), today) >= KNOWLEDGE_REPLENISH_INTERVAL_DAYS
    const history = this.options.store.getKnowledgeSeedHistory()
    let drained = false
    let due = false
    if (randomOn) {
      const pool = this.knowledgePool()
      const unseen = countUnseenSeeds(pool, today, history)
      const poolDrained = this.poolConsumedFraction(pool.length, unseen) >= KNOWLEDGE_POOL_REPLENISH_THRESHOLD
      due = due || unseen < KNOWLEDGE_REPLENISH_MIN_UNSEEN || poolDrained || stale
      drained = drained || poolDrained
    }
    if (llmOn) {
      const cards = this.knowledgeCardPool()
      const unseenCards = countUnseenKnowledgeCards(cards, today, history)
      const cardsDrained = cards.length === 0 || this.poolConsumedFraction(cards.length, unseenCards) >= KNOWLEDGE_POOL_REPLENISH_THRESHOLD
      due = due || cardsDrained || stale
      drained = drained || cardsDrained
    }
    if (!due) return
    // One attempt a day by default. A refresh that drained a pool may chain another
    // batch onto a successful run, but a failed attempt never retries until tomorrow
    // so a broken provider is not hammered on every check.
    if (replenish.lastAttemptDate === today && (!drained || replenish.lastError)) return
    if (!this.options.resolveProviderConfig(preferences.providerId, preferences.modelId)?.model) return
    try {
      await this.replenishKnowledgePool()
    } catch (error) {
      console.warn('[daily-suggestions] Knowledge pool replenishment failed:', (error as Error).message)
    }
  }

  /**
   * User-initiated top-up from Settings. Ignores the due checks but still
   * needs a provider and at least one pool-backed source; returns the snapshot.
   */
  async replenishKnowledgePoolNow (): Promise<DailySuggestionSnapshot> {
    const preferences = this.options.store.getPreferences()
    if (!knowledgeUsesRandomPool(preferences) && !knowledgeNeedsModel(preferences)) throw new Error('KNOWLEDGE_RANDOM_DISABLED')
    if (!this.options.resolveProviderConfig(preferences.providerId, preferences.modelId)?.model) throw new Error('PROVIDER_MISSING')
    await this.replenishKnowledgePool()
    return this.getSnapshot()
  }

  private async replenishKnowledgePool (): Promise<number> {
    if (this.replenishing) return await this.replenishing
    this.replenishing = this.replenishInternal()
    this.emitChanged()
    try {
      return await this.replenishing
    } finally {
      this.replenishing = null
      this.emitChanged()
    }
  }

  /**
   * One pass tops up every active pool. Success is measured by new entries:
   * a run that adds nothing counts as a failure so it backs off until tomorrow
   * instead of retrying on every check.
   */
  private async replenishInternal (): Promise<number> {
    const now = this.now()
    const today = formatLocalDate(now)
    const preferences = this.options.store.getPreferences()
    const locale = this.options.getLocale()
    this.options.store.setKnowledgeReplenish({ lastAttemptDate: today })
    const providerConfig = this.options.resolveProviderConfig(preferences.providerId, preferences.modelId)
    if (!providerConfig || !providerConfig.model) {
      this.options.store.setKnowledgeReplenish({ lastError: 'PROVIDER_MISSING' })
      throw new Error('PROVIDER_MISSING')
    }
    const randomOn = knowledgeUsesRandomPool(preferences)
    const llmOn = knowledgeNeedsModel(preferences)
    let added = 0
    const errors: string[] = []
    if (randomOn) {
      try {
        added += await this.topUpSeedPool(providerConfig, now, today, locale)
      } catch (caught) {
        errors.push((caught as Error).message || String(caught))
      }
    }
    if (llmOn) {
      try {
        added += await this.topUpKnowledgeCards(providerConfig, now, locale, preferences)
      } catch (caught) {
        errors.push((caught as Error).message || String(caught))
      }
    }
    if (added === 0) {
      const message = errors[0] || 'MODEL_OUTPUT_EMPTY'
      this.options.store.setKnowledgeReplenish({ lastError: message })
      throw new Error(message)
    }
    this.options.store.setKnowledgeReplenish({ lastSuccessAt: now.toISOString(), lastError: '' })
    return added
  }

  private async topUpSeedPool (providerConfig: AIConfigInput, now: Date, today: string, locale: string): Promise<number> {
    const generated = this.options.store.getGeneratedSeeds()
    const existingIds = new Set<string>()
    for (const seed of KNOWLEDGE_SEEDS) existingIds.add(seed.id)
    for (const seed of generated) existingIds.add(seed.id)
    const existingTitles = new Set(generated.filter(seed => seed.copy.locale === locale).map(seed => titleKey(seed.copy.title)))
    const engine = await this.options.resolveAiEngine()
    const reply = await engine.chat([{ role: 'user', content: this.buildReplenishPrompt(locale, generated) }], {
      providerConfig,
      authMode: 'auto',
      allowedToolNames: [NO_TOOLS_SENTINEL],
      conversationId: `daily-suggestions:pool:${today}:${crypto.randomUUID()}`
    })
    const parsed = extractJsonArray(this.replyText(reply.content))
    if (!parsed) throw new Error('MODEL_OUTPUT_NOT_JSON')
    const seeds = parsed
      .map(raw => normalizeGeneratedSeed(raw, locale, now, existingIds, existingTitles))
      .filter((seed): seed is GeneratedKnowledgeSeed => seed !== null)
      .slice(0, KNOWLEDGE_REPLENISH_BATCH)
    if (seeds.length === 0) throw new Error('MODEL_OUTPUT_EMPTY')
    const pinned = this.options.store.getKnowledgeToday(today)
    return this.options.store.appendGeneratedSeeds(seeds, pinned ? [pinned.seedId] : [])
  }

  private async topUpKnowledgeCards (providerConfig: AIConfigInput, now: Date, locale: string, preferences: DailySuggestionPreferences): Promise<number> {
    const existingTitles = new Set(
      this.knowledgeCardPool().map(card => `${card.source}|${card.copy.locale}|${titleKey(card.copy.title)}`)
    )
    const engine = await this.options.resolveAiEngine()
    const reply = await engine.chat([{ role: 'user', content: this.buildCardReplenishPrompt(preferences) }], {
      providerConfig,
      authMode: 'auto',
      allowedToolNames: [NO_TOOLS_SENTINEL],
      conversationId: `daily-suggestions:cards:${formatLocalDate(now)}:${crypto.randomUUID()}`
    })
    const parsed = extractJsonArray(this.replyText(reply.content))
    if (!parsed) throw new Error('MODEL_OUTPUT_NOT_JSON')
    const cards = parsed
      .map(raw => normalizeGeneratedKnowledgeCard(raw, preferences.knowledge, locale, now, existingTitles))
      .filter((card): card is GeneratedKnowledgeCard => card !== null)
      .slice(0, KNOWLEDGE_CARD_REPLENISH_BATCH * this.selectedKnowledgeLlmSources(preferences).length)
    if (cards.length === 0) throw new Error('MODEL_OUTPUT_EMPTY')
    const today = formatLocalDate(now)
    const shownToday = new Set(
      (this.options.store.getBatch(today)?.items || [])
        .filter(item => item.layer === 'knowledge')
        .map(item => item.knowledge?.seedId)
        .filter((id): id is string => !!id)
    )
    return this.options.store.appendKnowledgeCards(cards, [...shownToday])
  }

  private replyText (content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map(part => {
        const record = part as Record<string, unknown>
        return typeof record.text === 'string' ? record.text : ''
      }).join('\n')
    }
    return ''
  }

  private buildReplenishPrompt (locale: string, generated: GeneratedKnowledgeSeed[]): string {
    const lines: string[] = []
    lines.push('You extend a pool of "curiosity hook" cards for WorldBase, a desktop AI workspace. Each card is shown on an empty chat screen once a day; clicking it starts a relaxed conversation with the assistant about an idea, phenomenon or story the user probably never dug into. The goal is to make them curious, not to make them productive.')
    lines.push(`Write every title, description and prompt in the language with locale tag "${locale}". The "slug" field is always English.`)
    lines.push('')
    lines.push('## Already in the pool (never repeat these topics or close variants)')
    for (const seed of KNOWLEDGE_SEEDS) lines.push(`- ${seed.id}`)
    for (const seed of generated) lines.push(`- ${seed.id}${seed.copy.locale === locale ? `: ${clip(seed.copy.title, 60)}` : ''}`)
    lines.push('')
    lines.push('## What to generate')
    lines.push(`Produce exactly ${KNOWLEDGE_REPLENISH_BATCH} items, one for each of these disciplines in this order: ${KNOWLEDGE_DISCIPLINES.join(', ')}.`)
    lines.push('Each item is a real, well-documented concept, effect, paradox, law, experiment or historical episode. The title must be a question or a counter-intuitive fact, never a dictionary headword. The description is one sentence that deepens the hook or names an unexpected connection.')
    lines.push('')
    lines.push('## Output format')
    lines.push('Reply with a JSON array only, no prose, no code fence. Each element:')
    lines.push('{"discipline": "<one of the discipline keys above>", "slug": "<discipline>-<2-4 english kebab-case words naming the topic, e.g. physics-mpemba-effect>", "title": "<= 20 words", "description": "one sentence", "prompt": "the full message the user would send to the assistant"}')
    lines.push('The prompt must follow this shape, adapted to the topic: "I\'m curious about X. Start with an everyday analogy for what it is, then tell me the most counter-intuitive thing about it. Afterwards give me three directions I could ask about next and I\'ll pick one. Don\'t open with a definition."')
    lines.push('Replace the example placeholder X with the real topic name. Nothing you emit may contain a bare placeholder such as X, {topic} or <topic>, and every field must be written in the language named above.')
    lines.push('Rules: interesting first, useful second; never invent facts; never use software engineering as the subject; no two items about the same topic.')
    return lines.join('\n')
  }

  /**
   * Restock prompt for the LLM-source card pool. Leaner than the daily
   * knowledge prompt: it runs in the background, so it carries the user's
   * declared profile and what the pool already covers, but not live project
   * or conversation context.
   */
  private buildCardReplenishPrompt (preferences: DailySuggestionPreferences): string {
    const knowledge = preferences.knowledge
    const sources = this.selectedKnowledgeLlmSources(preferences)
    const perSource = KNOWLEDGE_CARD_REPLENISH_BATCH
    const lines: string[] = []
    lines.push('You restock a pool of "curiosity hook" cards for WorldBase, a desktop AI workspace. Cards are drawn from the pool onto the empty chat screen; clicking one starts a relaxed conversation with the assistant about an idea, phenomenon or story the user probably never dug into. The goal is to make them curious, not to make them productive.')
    lines.push(`Write every title, description and prompt in the language with locale tag "${this.options.getLocale()}".`)
    lines.push('')
    lines.push('## About the user')
    lines.push(`Profession / field: ${knowledge.profession ? clip(knowledge.profession, 60) : 'not stated'}.`)
    lines.push(`Declared interests: ${knowledge.interests.length > 0 ? knowledge.interests.map(item => clip(item, 30)).join(', ') : 'none'}.`)
    lines.push('')
    lines.push('## Cards already in the pool (never repeat these titles or close variants)')
    for (const card of this.knowledgeCardPool()) lines.push(`- ${card.source}: ${clip(card.copy.title, 60)}`)
    lines.push('')
    lines.push('## What to generate')
    lines.push(`Produce exactly ${perSource} items for EACH of the following sources, and nothing for any other source:`)
    for (const source of sources) lines.push(`- "${source}": ${KNOWLEDGE_SOURCE_INSTRUCTIONS[source]}`)
    lines.push('')
    lines.push('## Output format')
    lines.push('Reply with a JSON array only, no prose, no code fence. Each element:')
    lines.push('{"source": "<one of the sources above>", "discipline": "<discipline or topic, <= 20 characters>", "title": "<= 20 words; a question or a counter-intuitive fact, never a dictionary headword", "description": "one sentence that deepens the hook or names an unexpected connection", "prompt": "the full message the user would send to the assistant"}')
    lines.push('The prompt must follow this shape, adapted to the topic: "I\'m curious about X. Start with an everyday analogy for what it is, then tell me the most counter-intuitive thing about it. Afterwards give me three directions I could ask about next and I\'ll pick one. Don\'t open with a definition."')
    lines.push('Replace the example placeholder X with the real topic name. Nothing you emit may contain a bare placeholder such as X, {topic} or <topic>, and every field must be written in the language named above.')
    lines.push('Rules: interesting first, useful second; never invent facts; avoid software engineering as the subject for cross-discipline; no two items about the same topic.')
    return lines.join('\n')
  }

  private findSuggestion (suggestionId: string): WorkSuggestion | null {
    if (suggestionId.startsWith('static:')) {
      return buildExploreSuggestions(this.now()).items.find(item => item.id === suggestionId) || null
    }
    if (suggestionId.startsWith(KNOWLEDGE_STATIC_ID_PREFIX)) {
      // `knowledge:<date>:<seedId>`; seed ids never contain a colon.
      const seedId = suggestionId.split(':')[2] || ''
      const seed = findKnowledgeSeed(seedId, this.options.store.getGeneratedSeeds())
      return seed ? buildKnowledgeSeedSuggestion(seed, this.now()) : null
    }
    if (suggestionId.startsWith(KNOWLEDGE_CARD_ID_PREFIX)) {
      // `kcard:<date>:<cardId>`; card ids never contain a colon.
      const cardId = suggestionId.split(':')[2] || ''
      const card = this.knowledgeCardPool().find(entry => entry.id === cardId)
      return card ? buildKnowledgeCardSuggestion(card, this.now()) : null
    }
    for (const batch of this.options.store.getBatches()) {
      const found = batch.items.find(item => item.id === suggestionId)
      if (found) return found
    }
    return null
  }

  private clearFreshFlag (suggestionId: string): void {
    for (const batch of this.options.store.getBatches()) {
      if (!batch.items.some(item => item.id === suggestionId)) continue
      this.options.store.saveBatch({
        ...batch,
        items: batch.items.map(item => item.id === suggestionId ? { ...item, fresh: false } : item)
      })
      return
    }
  }

  /** Today's batch, or the most recent successful one if today's failed / is missing and still fresh enough. */
  private resolveDisplayBatch (preferences: DailySuggestionPreferences, now: Date): DailySuggestionBatch | null {
    if (!preferences.enabled && !knowledgeNeedsModel(preferences)) return null
    const today = formatLocalDate(now)
    const batches = this.options.store.getBatches()
    const todays = batches.find(batch => batch.date === today)
    if (todays && todays.status !== 'failed') return todays
    const lastGood = batches.find(batch => batch.status !== 'failed' && daysBetween(batch.date, today) <= STALE_BATCH_MAX_AGE_DAYS)
    if (lastGood) {
      // Surface today's failure while keeping yesterday's items visible.
      return todays ? { ...lastGood, status: 'failed', error: todays.error, manualRefreshCount: todays.manualRefreshCount, date: today, generatedAt: todays.generatedAt } : lastGood
    }
    return todays || null
  }

  private reschedule (): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.disposed) return
    const preferences = this.options.store.getPreferences()
    if ((!preferences.enabled && !knowledgeNeedsModel(preferences)) || preferences.trigger.kind !== 'time') return
    const next = this.nextTimeTriggerAt(preferences.trigger.timeOfDay)
    const delay = Math.max(1000, next.getTime() - this.now().getTime())
    // setTimeout clamps at ~24.8 days; a daily schedule never exceeds that.
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runIfDue('schedule').finally(() => this.reschedule())
    }, delay)
  }

  private nextTimeTriggerAt (timeOfDay: string): Date {
    const [hours, minutes] = timeOfDay.split(':').map(Number)
    const now = this.now()
    const next = new Date(now)
    next.setHours(hours, minutes, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next
  }

  /**
   * Generate when today has no batch yet and the trigger says so:
   *  - first-open: any startup/enable counts.
   *  - time: startup only catches up if the scheduled time already passed today.
   */
  private async runIfDue (reason: 'startup' | 'enable' | 'schedule'): Promise<void> {
    const preferences = this.options.store.getPreferences()
    if (!preferences.enabled && !knowledgeNeedsModel(preferences)) return
    const today = formatLocalDate(this.now())
    const existing = this.options.store.getBatch(today)
    // A batch generated before a group was switched on lacks that group's items; run again once.
    const missingGroup = existing && reason === 'enable' && (
      (preferences.enabled && !existing.items.some(item => item.layer === 'daily'))
      || (knowledgeNeedsModel(preferences) && !existing.items.some(item => item.layer === 'knowledge'))
    )
    if (existing && !missingGroup) return
    if (preferences.trigger.kind === 'time' && reason === 'startup') {
      const [hours, minutes] = preferences.trigger.timeOfDay.split(':').map(Number)
      const scheduled = new Date(this.now())
      scheduled.setHours(hours, minutes, 0, 0)
      if (scheduled.getTime() > this.now().getTime()) return
    }
    try {
      await this.generate({ manual: false })
    } catch (error) {
      console.warn('[daily-suggestions] Generation failed:', (error as Error).message)
    }
  }

  private async generate (context: { manual: boolean }): Promise<DailySuggestionBatch | null> {
    if (this.generating) return await this.generating
    this.generating = this.generateInternal(context)
    this.emitChanged()
    try {
      return await this.generating
    } finally {
      this.generating = null
      this.emitChanged()
    }
  }

  private async generateInternal (context: { manual: boolean }): Promise<DailySuggestionBatch | null> {
    const now = this.now()
    const today = formatLocalDate(now)
    const preferences = this.options.store.getPreferences()
    const previous = this.options.store.getBatch(today)
    const manualRefreshCount = (previous?.manualRefreshCount || 0) + (context.manual && previous ? 1 : 0)
    const wantDaily = preferences.enabled
    const wantKnowledge = knowledgeNeedsModel(preferences)

    const providerConfig = this.options.resolveProviderConfig(preferences.providerId, preferences.modelId)
    if (!providerConfig || !providerConfig.model) {
      this.providerMissing = true
      const batch: DailySuggestionBatch = {
        date: today,
        status: 'failed',
        items: previous?.items || [],
        generatedAt: now.toISOString(),
        error: 'PROVIDER_MISSING',
        manualRefreshCount,
        providerId: preferences.providerId,
        modelId: preferences.modelId
      }
      this.options.store.saveBatch(batch)
      return batch
    }
    this.providerMissing = false

    const [projects, conversations, capabilities] = await Promise.all([
      preferences.context.projects ? this.options.listProjects().catch(() => [] as SuggestionProjectContext[]) : Promise.resolve([] as SuggestionProjectContext[]),
      preferences.context.conversationTitles ? this.options.listConversations().catch(() => [] as SuggestionConversationContext[]) : Promise.resolve([] as SuggestionConversationContext[]),
      this.options.getCapabilities().catch(() => ({ skillNames: [], mcpServerNames: [], scheduledTaskCount: 0, longTermGoalCount: 0, agentGroupCount: 0 }))
    ])
    const projectIds = new Set(projects.map(project => project.id))

    // The two groups are separate requests so one failing never empties the other,
    // and the daily JSON contract stays exactly as it was. The knowledge group
    // draws from the local card pool first and only calls the model for the
    // shortfall, so refreshing never has to wait on a completion.
    const [dailyResult, knowledgeResult] = await Promise.all([
      wantDaily
        ? this.requestItems(providerConfig, today, this.buildPrompt(preferences, projects, conversations, capabilities), raw => normalizeLlmSuggestion(raw, new Set(preferences.types), projectIds, now))
        : Promise.resolve({ items: [] as WorkSuggestion[], error: undefined as string | undefined, attempted: false }),
      wantKnowledge
        ? this.requestKnowledgeItems(providerConfig, today, preferences, projects, conversations, now)
        : Promise.resolve({ items: [] as WorkSuggestion[], error: undefined as string | undefined, attempted: false })
    ])

    // Daily: keep at most countPerType per type, then top up short types with static stand-ins.
    let dailyItems: WorkSuggestion[] = []
    let usedFallback = false
    if (wantDaily) {
      const grouped = new Map<SuggestionType, WorkSuggestion[]>()
      for (const type of preferences.types) grouped.set(type, [])
      for (const item of dailyResult.items) {
        const bucket = grouped.get(item.type as SuggestionType)
        if (bucket && bucket.length < preferences.countPerType) bucket.push(item)
      }
      const usedStaticIds = new Set<string>()
      for (const type of preferences.types) {
        const bucket = grouped.get(type)!
        if (bucket.length >= preferences.countPerType) continue
        for (const fallback of staticFallbacksForType(type, now, usedStaticIds)) {
          if (bucket.length >= preferences.countPerType) break
          bucket.push(fallback)
          usedStaticIds.add(fallback.id.split(':')[1])
          usedFallback = true
        }
      }
      dailyItems = preferences.types.flatMap(type => grouped.get(type) || [])
    }

    // Knowledge: already capped per source in `requestKnowledgeItems` (LLM items
    // first, pool-drawn cards fill the rest); no static top-up (the random seed is the fallback).
    const knowledgeItems = knowledgeResult.items

    const dailyLlmCount = dailyItems.filter(item => item.source === 'llm').length
    const dailyFailed = wantDaily && dailyLlmCount === 0
    const knowledgeFailed = wantKnowledge && knowledgeItems.length === 0
    const previousDaily = (previous?.items || []).filter(item => item.layer === 'daily')
    const previousKnowledge = (previous?.items || []).filter(item => item.layer === 'knowledge')

    let status: DailySuggestionBatchStatus
    if ((wantDaily ? dailyFailed : true) && (wantKnowledge ? knowledgeFailed : true)) status = 'failed'
    else if (dailyFailed || knowledgeFailed || usedFallback) status = 'partial'
    else status = 'ok'

    const batch: DailySuggestionBatch = {
      date: today,
      status,
      items: [
        ...(dailyFailed ? previousDaily : dailyItems),
        ...(knowledgeFailed ? previousKnowledge : knowledgeItems)
      ],
      generatedAt: now.toISOString(),
      error: dailyResult.error || knowledgeResult.error,
      manualRefreshCount,
      providerId: providerConfig.providerId || preferences.providerId,
      modelId: providerConfig.model || preferences.modelId
    }
    this.options.store.saveBatch(batch)
    return batch
  }

  /**
   * Pool-first knowledge group. Draws up to `countPerSource` cards per
   * selected source from the local pool; only the shortfall is requested from
   * the model, and whatever the model returns is banked into the pool so the
   * next refresh can draw without a completion.
   */
  private async requestKnowledgeItems (
    providerConfig: AIConfigInput,
    today: string,
    preferences: DailySuggestionPreferences,
    projects: SuggestionProjectContext[],
    conversations: SuggestionConversationContext[],
    now: Date
  ): Promise<{ items: WorkSuggestion[]; error: string | undefined; attempted: boolean }> {
    const sources = this.selectedKnowledgeLlmSources(preferences)
    const wanted = sources.length * preferences.knowledge.countPerSource
    if (wanted === 0) return { items: [], error: undefined, attempted: false }
    const locale = this.options.getLocale()
    const excluded = new Set(this.options.store.getDismissedIds())
    const cursor = this.options.store.bumpKnowledgeCardCursor()
    const poolItems = this.drawPoolKnowledgeItems(preferences, now, excluded, cursor)
    let llmItems: WorkSuggestion[] = []
    let error: string | undefined
    if (poolItems.length < wanted) {
      const result = await this.requestItems(
        providerConfig,
        today,
        this.buildKnowledgePrompt(preferences, projects, conversations, now),
        raw => normalizeKnowledgeSuggestion(raw, preferences.knowledge, now, locale)
      )
      error = result.error
      llmItems = result.items
      const existingTitles = new Set(
        this.knowledgeCardPool().map(card => `${card.source}|${card.copy.locale}|${titleKey(card.copy.title)}`)
      )
      const banked = llmItems
        .map(item => knowledgeCardFromSuggestion(item, locale, existingTitles))
        .filter((card): card is GeneratedKnowledgeCard => card !== null)
      if (banked.length > 0) this.options.store.appendKnowledgeCards(banked)
    }
    // Model items lead (freshest context), pool cards fill the rest, capped per source.
    const merged: WorkSuggestion[] = []
    const perSource = new Map<KnowledgeSource, number>()
    for (const item of [...llmItems, ...poolItems]) {
      const source = item.knowledge!.source
      const count = perSource.get(source) || 0
      if (count >= preferences.knowledge.countPerSource) continue
      perSource.set(source, count + 1)
      merged.push(item)
    }
    const drawnIds = merged
      .filter(item => item.id.startsWith(KNOWLEDGE_CARD_ID_PREFIX))
      .map(item => item.knowledge?.seedId)
      .filter((id): id is string => !!id)
    this.options.store.recordKnowledgeShown(today, drawnIds)
    return { items: merged, error, attempted: poolItems.length < wanted }
  }

  /** One plain completion, parsed as a JSON array and filtered through `normalize`. */
  private async requestItems (
    providerConfig: AIConfigInput,
    today: string,
    prompt: string,
    normalize: (raw: unknown) => WorkSuggestion | null
  ): Promise<{ items: WorkSuggestion[]; error: string | undefined; attempted: true }> {
    try {
      const engine = await this.options.resolveAiEngine()
      const reply = await engine.chat([{ role: 'user', content: prompt }], {
        providerConfig,
        authMode: 'auto',
        allowedToolNames: [NO_TOOLS_SENTINEL],
        // A dedicated id keeps these runs out of the user's conversation list.
        conversationId: `daily-suggestions:${today}:${crypto.randomUUID()}`
      })
      const parsed = extractJsonArray(this.replyText(reply.content))
      if (!parsed) throw new Error('MODEL_OUTPUT_NOT_JSON')
      return {
        items: parsed.map(normalize).filter((item): item is WorkSuggestion => item !== null),
        error: undefined,
        attempted: true
      }
    } catch (caught) {
      return { items: [], error: (caught as Error).message || String(caught), attempted: true }
    }
  }

  private buildKnowledgePrompt (
    preferences: DailySuggestionPreferences,
    projects: SuggestionProjectContext[],
    conversations: SuggestionConversationContext[],
    now: Date
  ): string {
    const knowledge = preferences.knowledge
    const sources = knowledge.sources.filter((source): source is Exclude<KnowledgeSource, 'random'> => source !== 'random')
    const lines: string[] = []
    lines.push('You write a few short "curiosity hooks" for a user of WorldBase, a desktop AI workspace. Each hook is a card the user can click to start a relaxed conversation with the assistant about an idea, phenomenon or story they probably never dug into. The goal is to make them curious, not to make them productive.')
    lines.push(`Write every title, description and prompt in the language with locale tag "${this.options.getLocale()}".`)
    lines.push('')
    lines.push('## About the user')
    lines.push(`Profession / field: ${knowledge.profession ? clip(knowledge.profession, 60) : 'not stated'}.`)
    lines.push(`Declared interests: ${knowledge.interests.length > 0 ? knowledge.interests.map(item => clip(item, 30)).join(', ') : 'none'}.`)
    if (projects.length > 0) {
      lines.push('Projects (name | type):')
      for (const project of projects.slice(0, MAX_PROJECTS_IN_CONTEXT)) lines.push(`- ${clip(project.name, 60)} | ${clip(project.type, 30)}`)
    }
    if (conversations.length > 0) {
      lines.push('Recent conversation titles (newest first):')
      for (const conversation of conversations.slice(0, MAX_CONVERSATIONS_IN_CONTEXT)) {
        const summary = preferences.context.conversationSummaries && conversation.previewText ? ` — ${clip(conversation.previewText, 140)}` : ''
        lines.push(`- ${clip(conversation.title, 80)}${summary}`)
      }
    }
    const pinned = this.options.store.getKnowledgeToday(formatLocalDate(now))
    const seed = pinned ? findKnowledgeSeed(pinned.seedId, this.options.store.getGeneratedSeeds()) : undefined
    if (seed && knowledge.sources.includes('random')) {
      lines.push(`Already shown today from the built-in pool: a card about "${seed.discipline}". Avoid that discipline.`)
    }
    lines.push('')
    lines.push('## What to generate')
    lines.push(`Produce exactly ${knowledge.countPerSource} item(s) for EACH of the following sources, and nothing for any other source:`)
    const streaks = this.options.store.getKnowledgeDismissStreaks()
    for (const source of sources) {
      if (source === 'interest' && knowledge.interests.length === 0) continue
      const streakNote = (streaks[source] || 0) >= 3 ? ' The user has recently dismissed several items from this source; take a clearly different angle.' : ''
      lines.push(`- "${source}": ${KNOWLEDGE_SOURCE_INSTRUCTIONS[source]}${streakNote}`)
    }
    lines.push('')
    lines.push('## Output format')
    lines.push('Reply with a JSON array only, no prose, no code fence. Each element:')
    lines.push('{"source": "<one of the sources above>", "discipline": "<discipline or topic, <= 20 characters>", "title": "<= 20 words; a question or a counter-intuitive fact, never a dictionary headword", "description": "one sentence that deepens the hook or names an unexpected connection", "prompt": "the full message the user would send to the assistant"}')
    const workClause = knowledge.profession
      ? ` If there is a surprising link to what I do (${clip(knowledge.profession, 60)}), mention it in passing.`
      : ''
    lines.push(`The prompt must follow this shape, adapted to the topic: "I'm curious about X. Start with an everyday analogy for what it is, then tell me the most counter-intuitive thing about it. Afterwards give me three directions I could ask about next and I'll pick one.${workClause} Don't open with a definition."`)
    lines.push('Replace the example placeholder X with the real topic name. Nothing you emit may contain a bare placeholder such as X, {topic} or <topic>, and every field must be written in the language named above.')
    lines.push('Rules: interesting first, useful second; never invent facts; avoid software engineering as the subject for cross-discipline; do not repeat the same topic across items.')
    return lines.join('\n')
  }

  private buildPrompt (
    preferences: DailySuggestionPreferences,
    projects: SuggestionProjectContext[],
    conversations: SuggestionConversationContext[],
    capabilities: SuggestionCapabilityContext
  ): string {
    const lines: string[] = []
    lines.push('You generate a short list of actionable daily suggestions for a user of WorldBase, a desktop AI workspace that can create and modify local projects, run them, analyze their databases, browse the web, use skills and MCP servers, control the computer, run scheduled tasks and long-term goals, and coordinate agent groups.')
    lines.push(`Write every title, description and prompt in the language with locale tag "${this.options.getLocale()}".`)
    lines.push('')
    lines.push('## User context')
    if (projects.length > 0) {
      lines.push('Projects (id | name | type | run state):')
      for (const project of projects.slice(0, MAX_PROJECTS_IN_CONTEXT)) {
        const state = project.status ? `${project.status}${project.port ? ` on port ${project.port}` : ''}` : 'unknown'
        lines.push(`- ${project.id} | ${clip(project.name, 60)} | ${clip(project.type, 30)} | ${state}`)
      }
    } else {
      lines.push('Projects: none listed.')
    }
    if (conversations.length > 0) {
      lines.push('Recent conversation titles (newest first):')
      for (const conversation of conversations.slice(0, MAX_CONVERSATIONS_IN_CONTEXT)) {
        const summary = preferences.context.conversationSummaries && conversation.previewText ? ` — ${clip(conversation.previewText, 140)}` : ''
        lines.push(`- ${clip(conversation.title, 80)}${summary}`)
      }
    } else {
      lines.push('Recent conversations: none listed.')
    }
    lines.push(`Installed skills: ${capabilities.skillNames.length > 0 ? capabilities.skillNames.slice(0, 15).map(name => clip(name, 40)).join(', ') : 'none'}.`)
    lines.push(`Configured MCP servers: ${capabilities.mcpServerNames.length > 0 ? capabilities.mcpServerNames.slice(0, 15).map(name => clip(name, 40)).join(', ') : 'none'}.`)
    lines.push(`Scheduled tasks: ${capabilities.scheduledTaskCount}. Long-term goals: ${capabilities.longTermGoalCount}. Agent groups: ${capabilities.agentGroupCount}.`)
    lines.push('')
    lines.push('## What to generate')
    lines.push(`Produce exactly ${preferences.countPerType} items for EACH of the following types, and nothing for any other type:`)
    const streaks = this.options.store.getTypeDismissStreaks()
    for (const type of preferences.types) {
      const streakNote = (streaks[type] || 0) >= 3 ? ' The user has recently dismissed several items of this type; take a clearly different angle.' : ''
      lines.push(`- "${type}": ${TYPE_INSTRUCTIONS[type]}${streakNote}`)
    }
    lines.push('')
    lines.push('## Output format')
    lines.push('Reply with a JSON array only, no prose, no code fence. Each element:')
    lines.push('{"type": "<one of the types above>", "title": "<= 20 words, imperative, specific", "description": "one sentence on why it is worth doing", "prompt": "the full message the user would send to the assistant to start this work; concrete and self-contained", "scene": {"targetProjectId": "<a project id from the list, only when the item is about that project>", "planMode": true|false, "computerUse": true|false}}')
    lines.push('Rules: reference projects by their listed id in scene.targetProjectId and by name in text; set planMode true for multi-step code changes; set computerUse true only when the task needs to operate desktop apps; never invent projects, tools or data that are not in the context; avoid repeating the same idea across types.')
    return lines.join('\n')
  }

  private emitChanged (): void {
    if (!this.options.onChanged) return
    try {
      this.options.onChanged(this.getSnapshot())
    } catch (error) {
      console.warn('[daily-suggestions] onChanged failed:', (error as Error).message)
    }
  }
}
