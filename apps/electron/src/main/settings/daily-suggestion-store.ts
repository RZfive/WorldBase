import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  isKnowledgeSource,
  normalizeDailySuggestionPreferences,
  type DailySuggestionBatch,
  type DailySuggestionPreferences,
  type KnowledgeSource,
  type SuggestionType,
  type WorkSuggestion
} from '../../shared/daily-suggestion-types.js'
import type { KnowledgeSeedHistoryEntry } from '../suggestions/knowledge-seeds.js'

interface DailySuggestionStoreSnapshot {
  preferences: DailySuggestionPreferences
  /** Newest first, capped at MAX_BATCH_HISTORY. */
  batches: DailySuggestionBatch[]
  dismissedIds: string[]
  /** Consecutive dismissals per type, reset when the user picks an item of that type. */
  typeDismissStreaks: Partial<Record<SuggestionType, number>>
  /** Same idea for knowledge sources. */
  knowledgeDismissStreaks: Partial<Record<KnowledgeSource, number>>
  /** Random seeds shown recently, oldest first, so the daily draw avoids repeats. */
  knowledgeSeedHistory: KnowledgeSeedHistoryEntry[]
  /** The random seed resolved for today plus how often it was swapped. */
  knowledgeToday: { date: string; seedId: string; shuffleCount: number }
  /** Per-installation salt so two users do not draw the same seed on the same day. */
  knowledgeSalt: string
}

const MAX_BATCH_HISTORY = 7
const MAX_DISMISSED_IDS = 400
const MAX_SEED_HISTORY = 60

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    const next = normalizeString(item)
    if (next) seen.add(next)
  }
  return Array.from(seen)
}

function normalizeSuggestion (value: unknown): WorkSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = normalizeString(raw.id)
  const title = normalizeString(raw.title)
  const prompt = normalizeString(raw.prompt)
  const layer = raw.layer === 'daily' || raw.layer === 'explore' || raw.layer === 'knowledge' ? raw.layer : null
  const source = raw.source === 'llm' || raw.source === 'static' ? raw.source : null
  const type = normalizeString(raw.type)
  if (!id || !title || !prompt || !layer || !source || !type) return null
  const scene = raw.scene && typeof raw.scene === 'object' && !Array.isArray(raw.scene)
    ? raw.scene as WorkSuggestion['scene']
    : undefined
  const rawKnowledge = raw.knowledge && typeof raw.knowledge === 'object' && !Array.isArray(raw.knowledge)
    ? raw.knowledge as Record<string, unknown>
    : null
  const knowledge = rawKnowledge && isKnowledgeSource(rawKnowledge.source)
    ? {
        source: rawKnowledge.source,
        discipline: normalizeString(rawKnowledge.discipline) || undefined,
        seedId: normalizeString(rawKnowledge.seedId) || undefined
      }
    : undefined
  if (layer === 'knowledge' && !knowledge) return null
  return {
    id,
    layer,
    type: type as WorkSuggestion['type'],
    title,
    description: normalizeString(raw.description) || undefined,
    prompt,
    scene,
    sendMode: raw.sendMode === 'send' ? 'send' : 'fill',
    source,
    featureTag: normalizeString(raw.featureTag) as WorkSuggestion['featureTag'] || undefined,
    knowledge,
    generatedAt: normalizeString(raw.generatedAt) || new Date(0).toISOString(),
    validUntil: normalizeString(raw.validUntil) || new Date(0).toISOString(),
    fresh: raw.fresh === true
  }
}

function normalizeBatch (value: unknown): DailySuggestionBatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const date = normalizeString(raw.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const status = raw.status === 'ok' || raw.status === 'partial' || raw.status === 'failed' ? raw.status : null
  if (!status) return null
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizeSuggestion).filter((item): item is WorkSuggestion => item !== null)
    : []
  const manualRefreshCount = typeof raw.manualRefreshCount === 'number' && Number.isFinite(raw.manualRefreshCount)
    ? Math.max(0, Math.floor(raw.manualRefreshCount))
    : 0
  return {
    date,
    status,
    items,
    generatedAt: normalizeString(raw.generatedAt) || new Date(0).toISOString(),
    error: normalizeString(raw.error) || undefined,
    manualRefreshCount,
    providerId: normalizeString(raw.providerId) || null,
    modelId: normalizeString(raw.modelId) || null
  }
}

function normalizeStreaks<K extends string> (value: unknown, accept: (key: string) => boolean): Partial<Record<K, number>> {
  const streaks: Partial<Record<K, number>> = {}
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  for (const [key, count] of Object.entries(raw)) {
    if (!accept(key)) continue
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      streaks[key as K] = Math.floor(count)
    }
  }
  return streaks
}

function normalizeSeedHistory (value: unknown): KnowledgeSeedHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const entries: KnowledgeSeedHistoryEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const seedId = normalizeString(raw.seedId)
    const date = normalizeString(raw.date)
    if (!seedId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    entries.push({ seedId, date })
  }
  return entries.slice(-MAX_SEED_HISTORY)
}

function normalizeSnapshot (value: unknown): DailySuggestionStoreSnapshot {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const batches = Array.isArray(raw.batches)
    ? raw.batches.map(normalizeBatch).filter((batch): batch is DailySuggestionBatch => batch !== null)
    : []
  batches.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const rawToday = raw.knowledgeToday && typeof raw.knowledgeToday === 'object' ? raw.knowledgeToday as Record<string, unknown> : {}
  const todayDate = normalizeString(rawToday.date)
  const todaySeedId = normalizeString(rawToday.seedId)
  const shuffleCount = typeof rawToday.shuffleCount === 'number' && Number.isFinite(rawToday.shuffleCount) ? Math.max(0, Math.floor(rawToday.shuffleCount)) : 0
  return {
    preferences: normalizeDailySuggestionPreferences(raw.preferences),
    batches: batches.slice(0, MAX_BATCH_HISTORY),
    dismissedIds: normalizeStringArray(raw.dismissedIds).slice(-MAX_DISMISSED_IDS),
    typeDismissStreaks: normalizeStreaks<SuggestionType>(raw.typeDismissStreaks, () => true),
    knowledgeDismissStreaks: normalizeStreaks<KnowledgeSource>(raw.knowledgeDismissStreaks, isKnowledgeSource),
    knowledgeSeedHistory: normalizeSeedHistory(raw.knowledgeSeedHistory),
    knowledgeToday: /^\d{4}-\d{2}-\d{2}$/.test(todayDate) && todaySeedId
      ? { date: todayDate, seedId: todaySeedId, shuffleCount }
      : { date: '', seedId: '', shuffleCount: 0 },
    knowledgeSalt: normalizeString(raw.knowledgeSalt) || crypto.randomUUID()
  }
}

/**
 * JSON-file persistence for daily suggestions, mirroring ScheduledTaskStore.
 * Everything is read through a normalizer so a hand-edited or partially
 * written file degrades to defaults instead of crashing startup.
 */
export class DailySuggestionStore {
  private readonly filePath: string
  private cache: DailySuggestionStoreSnapshot | null = null

  constructor (userDataPath: string) {
    this.filePath = path.join(userDataPath, 'daily-suggestions.json')
  }

  private read (): DailySuggestionStoreSnapshot {
    if (this.cache) return this.cache
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.cache = normalizeSnapshot(JSON.parse(raw))
        return this.cache
      }
    } catch (error) {
      console.error('[daily-suggestions] Failed to read store:', (error as Error).message)
    }
    this.cache = normalizeSnapshot({})
    return this.cache
  }

  private write (snapshot: DailySuggestionStoreSnapshot): void {
    const normalized = normalizeSnapshot(snapshot)
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), 'utf-8')
      this.cache = normalized
    } catch (error) {
      console.error('[daily-suggestions] Failed to write store:', (error as Error).message)
      throw error
    }
  }

  getPreferences (): DailySuggestionPreferences {
    return JSON.parse(JSON.stringify(this.read().preferences)) as DailySuggestionPreferences
  }

  savePreferences (preferences: DailySuggestionPreferences): DailySuggestionPreferences {
    const snapshot = this.read()
    this.write({ ...snapshot, preferences: normalizeDailySuggestionPreferences(preferences) })
    return this.getPreferences()
  }

  getBatches (): DailySuggestionBatch[] {
    return JSON.parse(JSON.stringify(this.read().batches)) as DailySuggestionBatch[]
  }

  getBatch (date: string): DailySuggestionBatch | null {
    return this.getBatches().find(batch => batch.date === date) || null
  }

  /** Insert or replace the batch for `batch.date`, keeping the newest MAX_BATCH_HISTORY. */
  saveBatch (batch: DailySuggestionBatch): void {
    const snapshot = this.read()
    const others = snapshot.batches.filter(existing => existing.date !== batch.date)
    this.write({ ...snapshot, batches: [batch, ...others] })
  }

  getDismissedIds (): Set<string> {
    return new Set(this.read().dismissedIds)
  }

  dismiss (suggestionId: string, type?: SuggestionType, knowledgeSource?: KnowledgeSource): void {
    const snapshot = this.read()
    if (snapshot.dismissedIds.includes(suggestionId)) return
    const streaks = { ...snapshot.typeDismissStreaks }
    if (type) streaks[type] = (streaks[type] || 0) + 1
    const knowledgeStreaks = { ...snapshot.knowledgeDismissStreaks }
    if (knowledgeSource) knowledgeStreaks[knowledgeSource] = (knowledgeStreaks[knowledgeSource] || 0) + 1
    this.write({
      ...snapshot,
      dismissedIds: [...snapshot.dismissedIds, suggestionId],
      typeDismissStreaks: streaks,
      knowledgeDismissStreaks: knowledgeStreaks
    })
  }

  /** Picking an item ends that type's / source's dismissal streak. */
  recordPick (type?: SuggestionType, knowledgeSource?: KnowledgeSource): void {
    const snapshot = this.read()
    const hasType = type && snapshot.typeDismissStreaks[type]
    const hasSource = knowledgeSource && snapshot.knowledgeDismissStreaks[knowledgeSource]
    if (!hasType && !hasSource) return
    const streaks = { ...snapshot.typeDismissStreaks }
    if (type) delete streaks[type]
    const knowledgeStreaks = { ...snapshot.knowledgeDismissStreaks }
    if (knowledgeSource) delete knowledgeStreaks[knowledgeSource]
    this.write({ ...snapshot, typeDismissStreaks: streaks, knowledgeDismissStreaks: knowledgeStreaks })
  }

  getTypeDismissStreaks (): Partial<Record<SuggestionType, number>> {
    return { ...this.read().typeDismissStreaks }
  }

  getKnowledgeDismissStreaks (): Partial<Record<KnowledgeSource, number>> {
    return { ...this.read().knowledgeDismissStreaks }
  }

  getKnowledgeSalt (): string {
    return this.read().knowledgeSalt
  }

  getKnowledgeSeedHistory (): KnowledgeSeedHistoryEntry[] {
    return this.read().knowledgeSeedHistory.map(entry => ({ ...entry }))
  }

  /** The seed already resolved for `date`, if any. */
  getKnowledgeToday (date: string): { seedId: string; shuffleCount: number } | null {
    const today = this.read().knowledgeToday
    return today.date === date && today.seedId ? { seedId: today.seedId, shuffleCount: today.shuffleCount } : null
  }

  /** Pin today's seed and record it in history. `shuffle` bumps the swap counter. */
  setKnowledgeToday (date: string, seedId: string, shuffle: boolean): void {
    const snapshot = this.read()
    const current = this.getKnowledgeToday(date)
    const shuffleCount = shuffle ? (current?.shuffleCount || 0) + 1 : (current?.shuffleCount || 0)
    const history = snapshot.knowledgeSeedHistory.some(entry => entry.seedId === seedId && entry.date === date)
      ? snapshot.knowledgeSeedHistory
      : [...snapshot.knowledgeSeedHistory, { seedId, date }].slice(-MAX_SEED_HISTORY)
    this.write({ ...snapshot, knowledgeToday: { date, seedId, shuffleCount }, knowledgeSeedHistory: history })
  }
}
