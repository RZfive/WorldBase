import type { MemoryEmbeddingSettings, MemoryIndexStatus } from '../../shared/agent-workspace-types.js'

export type SemanticMemoryPhase = MemoryIndexStatus['state'] | 'unsaved' | 'unconfigured' | 'unknown'

/** Provider selection is not proof that indexing succeeded. */
export function semanticMemoryPhase (
  draft: MemoryEmbeddingSettings,
  saved: MemoryEmbeddingSettings | null,
  index: MemoryIndexStatus | null
): SemanticMemoryPhase {
  if (saved && (draft.enabled !== saved.enabled || draft.providerId !== saved.providerId || draft.modelId !== saved.modelId)) return 'unsaved'
  if (!draft.enabled) return 'disabled'
  if (!draft.providerId || !draft.modelId) return 'unconfigured'
  if (!index) return 'unknown'
  if (!index.configured || index.providerId !== draft.providerId || index.modelId !== draft.modelId) return 'waiting'
  if (index.lastError || index.state === 'failed') return 'failed'
  if (index.documents.total === 0) return 'empty'
  if (index.state === 'ready' && index.vectorAvailable && index.generation?.status === 'active' && index.documents.indexed === index.documents.total) return 'ready'
  return index.generation ? 'indexing' : 'waiting'
}
