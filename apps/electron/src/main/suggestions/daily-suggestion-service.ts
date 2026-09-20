import crypto from 'node:crypto'
import type { AIConfigInput } from '../ai-engine/ai-engine.js'
import type { AIExecutionEngine } from '../ai-harness/types.js'
import type { DailySuggestionStore } from '../settings/daily-suggestion-store.js'
import {
  DAILY_SUGGESTION_MANUAL_REFRESH_LIMIT,
  KNOWLEDGE_SHUFFLE_LIMIT,
  LLM_KNOWLEDGE_SOURCES,
  formatLocalDate,
  isKnowledgeSource,
  isSuggestionType,
  normalizeDailySuggestionPreferences,
  type DailySuggestionBatch,
  type DailySuggestionBatchStatus,
  type DailySuggestionPreferences,
  type DailySuggestionSnapshot,
  type KnowledgePreferences,
  type KnowledgeSource,
  type SuggestionScene,
  type SuggestionType,
  type WorkSuggestion
} from '../../shared/daily-suggestion-types.js'
import { buildExploreSuggestions, staticFallbacksForType } from './static-suggestions.js'
import {
  KNOWLEDGE_STATIC_ID_PREFIX,
  buildKnowledgeSeedSuggestion,
  drawKnowledgeSeed,
  knowledgeSeedById,
  type KnowledgeSeedDefinition
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
 * and any scene is ignored: knowledge cards start a conversation, not a task.
 */
export function normalizeKnowledgeSuggestion (
  value: unknown,
  preferences: KnowledgePreferences,
  now: Date
): WorkSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isKnowledgeSource(raw.source) || raw.source === 'random' || !preferences.sources.includes(raw.source)) return null
  if (raw.source === 'interest' && preferences.interests.length === 0) return null
  const title = typeof raw.title === 'string' ? clip(raw.title, TITLE_MAX_LENGTH) : ''
  const prompt = typeof raw.prompt === 'string' ? clip(raw.prompt, PROMPT_MAX_LENGTH) : ''
  if (!title || !prompt) return null
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

/** Whether the knowledge group needs a model call under these preferences. */
export function knowledgeNeedsModel (preferences: DailySuggestionPreferences): boolean {
  return preferences.knowledge.enabled && preferences.knowledge.sources.some(source => (LLM_KNOWLEDGE_SOURCES as readonly string[]).includes(source))
}

export class DailySuggestionService {
  private readonly options: DailySuggestionServiceOptions
  private timer: ReturnType<typeof setTimeout> | null = null
  private checkInterval: ReturnType<typeof setInterval> | null = null
  private generating: Promise<DailySuggestionBatch | null> | null = null
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
    this.checkInterval = setInterval(() => this.reschedule(), RESCHEDULE_CHECK_INTERVAL_MS)
    void this.runIfDue('startup')
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
    return next
  }

  getSnapshot (): DailySuggestionSnapshot {
    const now = this.now()
    const preferences = this.options.store.getPreferences()
    const dismissed = this.options.store.getDismissedIds()
    const explore = buildExploreSuggestions(now)
    const batch = this.resolveDisplayBatch(preferences, now)
    const today = formatLocalDate(now)
    const knowledge: WorkSuggestion[] = []
    let shuffleRemaining = 0
    if (preferences.knowledge.enabled) {
      if (preferences.knowledge.sources.includes('random')) {
        const seed = this.resolveRandomSeed(now)
        const card = buildKnowledgeSeedSuggestion(seed, now)
        const shuffleCount = this.options.store.getKnowledgeToday(today)?.shuffleCount || 0
        shuffleRemaining = Math.max(0, KNOWLEDGE_SHUFFLE_LIMIT - shuffleCount)
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
      knowledgeShuffleRemaining: shuffleRemaining,
      weekTheme: explore.theme,
      lastGeneration: batch
        ? {
            date: batch.date,
            at: batch.generatedAt,
            status: batch.status,
            error: batch.error,
            manualRefreshCount: batch.manualRefreshCount,
            manualRefreshLimit: DAILY_SUGGESTION_MANUAL_REFRESH_LIMIT
          }
        : null,
      generating: this.generating !== null,
      providerMissing: this.providerMissing
    }
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
   * Swap today's random knowledge seed for another one. Limited per day and
   * independent of the LLM regeneration limit.
   */
  shuffleKnowledge (): DailySuggestionSnapshot {
    const now = this.now()
    const today = formatLocalDate(now)
    const preferences = this.options.store.getPreferences()
    if (!preferences.knowledge.enabled || !preferences.knowledge.sources.includes('random')) {
      throw new Error('KNOWLEDGE_RANDOM_DISABLED')
    }
    const current = this.options.store.getKnowledgeToday(today)
    const shuffleCount = current?.shuffleCount || 0
    if (shuffleCount >= KNOWLEDGE_SHUFFLE_LIMIT) throw new Error('KNOWLEDGE_SHUFFLE_LIMIT')
    const history = this.options.store.getKnowledgeSeedHistory()
    const salt = this.options.store.getKnowledgeSalt()
    let next: KnowledgeSeedDefinition | null = null
    // Attempts are deterministic; walk forward until the draw lands on a different seed.
    for (let attempt = shuffleCount + 1; attempt <= shuffleCount + 40 && !next; attempt++) {
      const candidate = drawKnowledgeSeed(today, salt, history, attempt)
      if (candidate.id !== current?.seedId) next = candidate
    }
    if (!next) throw new Error('KNOWLEDGE_POOL_EXHAUSTED')
    this.options.store.setKnowledgeToday(today, next.id, true)
    const snapshot = this.getSnapshot()
    this.options.onChanged?.(snapshot)
    return snapshot
  }

  /** Marks today's items as seen so the "new" badge shows once. */
  markSeen (): void {
    const batch = this.options.store.getBatch(formatLocalDate(this.now()))
    if (!batch || !batch.items.some(item => item.fresh)) return
    this.options.store.saveBatch({ ...batch, items: batch.items.map(item => ({ ...item, fresh: false })) })
  }

  /**
   * User-initiated regeneration. Enforces the per-day manual limit; the first
   * generation of a day (no batch yet) never counts against it.
   */
  async generateNow (): Promise<DailySuggestionSnapshot> {
    const preferences = this.options.store.getPreferences()
    if (!preferences.enabled && !knowledgeNeedsModel(preferences)) throw new Error('DAILY_SUGGESTIONS_DISABLED')
    const today = formatLocalDate(this.now())
    const existing = this.options.store.getBatch(today)
    if (existing && existing.manualRefreshCount >= DAILY_SUGGESTION_MANUAL_REFRESH_LIMIT) {
      throw new Error('DAILY_SUGGESTIONS_REFRESH_LIMIT')
    }
    await this.generate({ manual: true })
    return this.getSnapshot()
  }

  /** Today's random seed, drawing and pinning one on the first call of the day. */
  private resolveRandomSeed (now: Date): KnowledgeSeedDefinition {
    const today = formatLocalDate(now)
    const pinned = this.options.store.getKnowledgeToday(today)
    const existing = pinned ? knowledgeSeedById(pinned.seedId) : undefined
    if (existing) return existing
    const seed = drawKnowledgeSeed(today, this.options.store.getKnowledgeSalt(), this.options.store.getKnowledgeSeedHistory(), 0)
    this.options.store.setKnowledgeToday(today, seed.id, false)
    return seed
  }

  private findSuggestion (suggestionId: string): WorkSuggestion | null {
    if (suggestionId.startsWith('static:')) {
      return buildExploreSuggestions(this.now()).items.find(item => item.id === suggestionId) || null
    }
    if (suggestionId.startsWith(KNOWLEDGE_STATIC_ID_PREFIX)) {
      // `knowledge:<date>:<seedId>`; seed ids never contain a colon.
      const seedId = suggestionId.split(':')[2] || ''
      const seed = knowledgeSeedById(seedId)
      return seed ? buildKnowledgeSeedSuggestion(seed, this.now()) : null
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
    // and the daily JSON contract stays exactly as it was.
    const [dailyResult, knowledgeResult] = await Promise.all([
      wantDaily
        ? this.requestItems(providerConfig, today, this.buildPrompt(preferences, projects, conversations, capabilities), raw => normalizeLlmSuggestion(raw, new Set(preferences.types), projectIds, now))
        : Promise.resolve({ items: [] as WorkSuggestion[], error: undefined as string | undefined, attempted: false }),
      wantKnowledge
        ? this.requestItems(providerConfig, today, this.buildKnowledgePrompt(preferences, projects, conversations, now), raw => normalizeKnowledgeSuggestion(raw, preferences.knowledge, now))
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

    // Knowledge: at most countPerSource per LLM source, no static top-up (the random seed is the fallback).
    let knowledgeItems: WorkSuggestion[] = []
    if (wantKnowledge) {
      const perSource = new Map<KnowledgeSource, number>()
      for (const item of knowledgeResult.items) {
        const source = item.knowledge!.source
        const count = perSource.get(source) || 0
        if (count >= preferences.knowledge.countPerSource) continue
        perSource.set(source, count + 1)
        knowledgeItems.push(item)
      }
    }

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
      const text = typeof reply.content === 'string'
        ? reply.content
        : reply.content.map(part => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('\n')
      const parsed = extractJsonArray(text)
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
    const seed = pinned ? knowledgeSeedById(pinned.seedId) : undefined
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
