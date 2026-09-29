import type { MemoryEntry } from '../../shared/agent-workspace-types.js'

type MemoryCardText = Pick<MemoryEntry, 'summary' | 'details' | 'sourceText'>

/** Suppress duplicate legacy excerpts in the UI without changing stored text. */
export function hasAdditionalMemoryDetails (entry: MemoryCardText): boolean {
  const normalize = (value?: string) => (value || '').trim().replace(/\s+/g, ' ')
  const details = normalize(entry.details)
  return Boolean(details && details !== normalize(entry.summary) && details !== normalize(entry.sourceText))
}
