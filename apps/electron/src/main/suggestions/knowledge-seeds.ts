import { formatLocalDate, type KnowledgeSource, type WorkSuggestion } from '../../shared/daily-suggestion-types.js'

/**
 * Built-in "random knowledge" pool. Each seed is a curiosity hook: the title is
 * a question or a counter-intuitive fact, the description deepens the hook,
 * and the prompt opens a conversation rather than a task. Text lives in i18n
 * under `chatUi.suggestions.knowledgeSeeds.<id>` so the main process only
 * decides which seed shows today.
 *
 * Ids are stable once shipped: the store keeps a 30-day history keyed by them.
 */
export type KnowledgeDiscipline =
  | 'math' | 'physics' | 'economics' | 'psychology' | 'design' | 'history'
  | 'biology' | 'philosophy' | 'linguistics' | 'management' | 'statistics' | 'systems'

export interface KnowledgeSeedDefinition {
  id: string
  discipline: KnowledgeDiscipline
}

/** Verified against the copy in locales on 2026-09-19. */
export const KNOWLEDGE_SEEDS: readonly KnowledgeSeedDefinition[] = [
  { id: 'math-birthday-paradox', discipline: 'math' },
  { id: 'math-benford-law', discipline: 'math' },
  { id: 'math-monty-hall', discipline: 'math' },
  { id: 'physics-why-sky-blue', discipline: 'physics' },
  { id: 'physics-entropy-arrow', discipline: 'physics' },
  { id: 'physics-ice-floats', discipline: 'physics' },
  { id: 'econ-opportunity-cost', discipline: 'economics' },
  { id: 'econ-winners-curse', discipline: 'economics' },
  { id: 'econ-lemons-market', discipline: 'economics' },
  { id: 'psych-hick-law', discipline: 'psychology' },
  { id: 'psych-peak-end-rule', discipline: 'psychology' },
  { id: 'psych-dunning-kruger', discipline: 'psychology' },
  { id: 'design-golden-ratio-myth', discipline: 'design' },
  { id: 'design-norman-door', discipline: 'design' },
  { id: 'design-fitts-law', discipline: 'design' },
  { id: 'hist-longitude-prize', discipline: 'history' },
  { id: 'hist-qwerty-layout', discipline: 'history' },
  { id: 'hist-roman-concrete', discipline: 'history' },
  { id: 'bio-hex-honeycomb', discipline: 'biology' },
  { id: 'bio-immune-memory', discipline: 'biology' },
  { id: 'bio-ant-colony-routing', discipline: 'biology' },
  { id: 'phil-ship-of-theseus', discipline: 'philosophy' },
  { id: 'phil-occams-razor', discipline: 'philosophy' },
  { id: 'phil-trolley-problem', discipline: 'philosophy' },
  { id: 'ling-color-words-order', discipline: 'linguistics' },
  { id: 'ling-zipf-law', discipline: 'linguistics' },
  { id: 'ling-untranslatable-words', discipline: 'linguistics' },
  { id: 'mgmt-brooks-law', discipline: 'management' },
  { id: 'mgmt-parkinson-law', discipline: 'management' },
  { id: 'mgmt-goodhart-law', discipline: 'management' },
  { id: 'stat-simpsons-paradox', discipline: 'statistics' },
  { id: 'stat-survivorship-bias', discipline: 'statistics' },
  { id: 'stat-regression-to-mean', discipline: 'statistics' },
  { id: 'sys-littles-law', discipline: 'systems' },
  { id: 'sys-braess-paradox', discipline: 'systems' },
  { id: 'sys-cobra-effect', discipline: 'systems' }
] as const

const SEED_BY_ID = new Map(KNOWLEDGE_SEEDS.map(seed => [seed.id, seed]))

/** Seeds shown within this many days are skipped on a fresh draw. */
export const KNOWLEDGE_SEED_REUSE_DAYS = 30
const KNOWLEDGE_SEED_REUSE_DAYS_RELAXED = 14

export const KNOWLEDGE_STATIC_ID_PREFIX = 'knowledge:'

export function knowledgeSeedById (id: string): KnowledgeSeedDefinition | undefined {
  return SEED_BY_ID.get(id)
}

/** FNV-1a: stable across runs and platforms, which Math.random and V8's string hash are not. */
export function hashString (value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function daysBetweenDates (a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

export interface KnowledgeSeedHistoryEntry {
  seedId: string
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string
}

/**
 * Pick the seed for `date`. Deterministic for a given (date, salt, history)
 * so reopening the app on the same day shows the same card; the salt is a
 * per-installation random string so different users do not all see the same
 * seed on the same day. Recently shown seeds are excluded; when the pool runs
 * dry the window relaxes, and finally nothing is excluded.
 */
export function drawKnowledgeSeed (date: string, salt: string, history: KnowledgeSeedHistoryEntry[], attempt = 0): KnowledgeSeedDefinition {
  const windows = [KNOWLEDGE_SEED_REUSE_DAYS, KNOWLEDGE_SEED_REUSE_DAYS_RELAXED, 0]
  for (const window of windows) {
    const excluded = new Set(
      history
        .filter(entry => window === 0 ? false : daysBetweenDates(entry.date, date) < window)
        .map(entry => entry.seedId)
    )
    const candidates = KNOWLEDGE_SEEDS.filter(seed => !excluded.has(seed.id))
    if (candidates.length === 0) continue
    const index = hashString(`${date}|${salt}|${attempt}`) % candidates.length
    return candidates[index]
  }
  return KNOWLEDGE_SEEDS[0]
}

function endOfLocalDayIso (now: Date): string {
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}

export function buildKnowledgeSeedSuggestion (seed: KnowledgeSeedDefinition, now: Date): WorkSuggestion {
  const prefix = `chatUi.suggestions.knowledgeSeeds.${seed.id}`
  return {
    // Date-scoped so dismissing today's card does not hide the seed forever.
    id: `${KNOWLEDGE_STATIC_ID_PREFIX}${formatLocalDate(now)}:${seed.id}`,
    layer: 'knowledge',
    type: 'knowledge',
    title: `${prefix}.title`,
    description: `${prefix}.description`,
    prompt: `${prefix}.prompt`,
    sendMode: 'fill',
    source: 'static',
    knowledge: { source: 'random' satisfies KnowledgeSource, discipline: seed.discipline, seedId: seed.id },
    generatedAt: now.toISOString(),
    validUntil: endOfLocalDayIso(now)
  }
}
