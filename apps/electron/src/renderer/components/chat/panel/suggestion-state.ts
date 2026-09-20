import { ref } from 'vue'
import type { DailySuggestionSnapshot, WorkSuggestion } from '../../../../shared/daily-suggestion-types.js'

/**
 * Renderer cache of the daily-suggestion snapshot. Module-level so the empty
 * state and the settings panel share one subscription and one copy of state.
 */
export const dailySuggestionSnapshot = ref<DailySuggestionSnapshot | null>(null)
export const dailySuggestionLoading = ref(false)

let changeCleanup: (() => void) | null = null
let loadPromise: Promise<void> | null = null

export async function loadDailySuggestions (force = false): Promise<void> {
  if (!window.electronAPI?.getDailySuggestionSnapshot) return
  if (loadPromise && !force) return await loadPromise
  dailySuggestionLoading.value = true
  loadPromise = (async () => {
    try {
      dailySuggestionSnapshot.value = await window.electronAPI!.getDailySuggestionSnapshot!()
    } catch {
      /* keep the previous snapshot */
    } finally {
      dailySuggestionLoading.value = false
    }
  })()
  try {
    await loadPromise
  } finally {
    loadPromise = null
  }
}

export function ensureDailySuggestionSubscription (): void {
  if (changeCleanup || !window.electronAPI?.onDailySuggestionsChanged) return
  changeCleanup = window.electronAPI.onDailySuggestionsChanged((snapshot) => {
    dailySuggestionSnapshot.value = snapshot
  })
}

export function disposeDailySuggestionSubscription (): void {
  changeCleanup?.()
  changeCleanup = null
}

export async function dismissDailySuggestion (suggestion: WorkSuggestion): Promise<void> {
  if (!window.electronAPI?.dismissDailySuggestion) return
  // Optimistic removal so the card disappears on click, not after the round trip.
  const current = dailySuggestionSnapshot.value
  if (current) {
    dailySuggestionSnapshot.value = {
      ...current,
      daily: current.daily.filter(item => item.id !== suggestion.id),
      explore: current.explore.filter(item => item.id !== suggestion.id),
      knowledge: (current.knowledge ?? []).filter(item => item.id !== suggestion.id)
    }
  }
  try {
    dailySuggestionSnapshot.value = await window.electronAPI.dismissDailySuggestion(suggestion.id)
  } catch {
    /* the optimistic state stands until the next snapshot */
  }
}

export const knowledgeShuffling = ref(false)

/** Swap today's random knowledge seed. Errors (limit reached, disabled) leave the snapshot as is. */
export async function shuffleKnowledgeSuggestion (): Promise<void> {
  if (!window.electronAPI?.shuffleKnowledgeSuggestion || knowledgeShuffling.value) return
  knowledgeShuffling.value = true
  try {
    dailySuggestionSnapshot.value = await window.electronAPI.shuffleKnowledgeSuggestion()
  } catch {
    await loadDailySuggestions(true)
  } finally {
    knowledgeShuffling.value = false
  }
}

export function recordDailySuggestionPick (suggestion: WorkSuggestion): void {
  void window.electronAPI?.recordDailySuggestionPick?.(suggestion.id).catch(() => {})
}

export function markDailySuggestionsSeen (): void {
  const current = dailySuggestionSnapshot.value
  if (!current) return
  const fresh = current.daily.some(item => item.fresh) || (current.knowledge ?? []).some(item => item.fresh)
  if (!fresh) return
  void window.electronAPI?.markDailySuggestionsSeen?.().catch(() => {})
}
