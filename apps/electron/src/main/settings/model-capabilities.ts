import { REASONING_EFFORT_ORDER } from '../../shared/reasoning-effort.js'

/**
 * Per-model capability record persisted with each provider. Extracted from
 * settings-store so the normalize logic stays electron-free and testable.
 */
export interface ModelCapabilityEntry {
  imageGeneration?: boolean
  imageEditing?: boolean
  /** Reasoning effort values the gateway declares this model accepts. */
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
  /** User-chosen default reasoning strength for this model. */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  /** Levels the user allows for this model (multi-pick in settings).
   *  Absent/empty = all levels allowed. */
  allowedReasoningEfforts?: string[]
}

/** Keep non-empty string arrays; anything else (or an empty list) is dropped. */
function normalizeStringArray (value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : undefined
}

/**
 * Sanitize per-model capabilities for persistence. Reasoning-effort metadata
 * must survive the save/load round-trip: the gateway-declared levels drive the
 * request-time clamp and the settings UI's multi-select universe, and the
 * user's allowed pick narrows it — dropping them here resets every model to
 * the full canonical enum after the next save.
 */
export function normalizeModelCapabilities (
  value: unknown,
  models: string[]
): Record<string, ModelCapabilityEntry> {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  const normalized: Record<string, ModelCapabilityEntry> = {}

  for (const model of models) {
    const raw = (input[model] && typeof input[model] === 'object')
      ? input[model] as Record<string, unknown>
      : {}
    const entry: ModelCapabilityEntry = {
      imageGeneration: raw.imageGeneration === true,
      imageEditing: raw.imageEditing === true
    }
    const reasoningEfforts = normalizeStringArray(raw.reasoningEfforts)
    if (reasoningEfforts) entry.reasoningEfforts = reasoningEfforts
    if (typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort) {
      entry.defaultReasoningEffort = raw.defaultReasoningEffort
    }
    if (typeof raw.reasoningEffort === 'string' && REASONING_EFFORT_ORDER.includes(raw.reasoningEffort)) {
      entry.reasoningEffort = raw.reasoningEffort as ModelCapabilityEntry['reasoningEffort']
    }
    const allowedReasoningEfforts = normalizeStringArray(raw.allowedReasoningEfforts)
    if (allowedReasoningEfforts) entry.allowedReasoningEfforts = allowedReasoningEfforts
    normalized[model] = entry
  }

  return normalized
}
