/**
 * Reasoning-effort scale shared by the main process (request-time clamping)
 * and the renderer (session strength adaptation when switching models).
 */

/**
 * Canonical ordering, weaker to stronger — mirrors cc-switch's
 * CANONICAL_EFFORTS: none < minimal < low < medium < high < xhigh < max < ultra.
 */
export const REASONING_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/**
 * Clamp a requested reasoning effort to what the model actually accepts.
 * Missing/empty declarations and unknown requested values pass through so
 * the legacy mapping keeps handling gateways without metadata. Nearest
 * declared level wins on the minimal<low<medium<high<max scale; a tie
 * resolves to the stronger level (e.g. medium → high on low/high/max sets).
 */
export function clampReasoningEffort (requested: string, supported?: string[]): string {
  if (!supported || supported.length === 0 || supported.includes(requested)) return requested
  const requestedIndex = REASONING_EFFORT_ORDER.indexOf(requested)
  if (requestedIndex < 0) return requested
  const candidates = supported
    .map(effort => REASONING_EFFORT_ORDER.indexOf(effort))
    .filter(index => index >= 0)
  if (candidates.length === 0) return requested
  const best = candidates.reduce((left, right) => {
    const leftDiff = Math.abs(left - requestedIndex)
    const rightDiff = Math.abs(right - requestedIndex)
    // Equal distance: prefer the stronger level (larger order index).
    return leftDiff < rightDiff || (leftDiff === rightDiff && left > right) ? left : right
  })
  return REASONING_EFFORT_ORDER[best]
}

/**
 * The per-model capability record, split by declaration owner so the two
 * sources stay distinguishable at save time: `reasoningEfforts` /
 * `defaultReasoningEffort` are gateway-declared (from the /models catalog,
 * overwritten on every refresh), while `reasoningEffort` /
 * `allowedReasoningEfforts` are user-declared (settings UI, must survive
 * refreshes). Both persist side by side in `modelCapabilities[model]`.
 */
export interface ReasoningCapabilityFields {
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
  reasoningEffort?: string
  allowedReasoningEfforts?: string[]
}

/** What the strength control renders: the level set and the active level. */
export interface ResolvedModelStrength {
  /** Display levels — declared ∩ allowed, canonically ordered weak→strong. */
  levels: string[]
  /** Display value — remembered → user default → gateway default → current. */
  active: string
}

/**
 * The single derivation every strength display reads. Merges the two
 * declaration sources into one view: the button set is what the gateway
 * declares narrowed by what the user allows (standard eight when undeclared),
 * and the active value follows the user's last pick for this model, then the
 * user-chosen default, then the gateway default, then the current value —
 * snapped to the nearest supported level only when the current one is not
 * accepted. Undeclared models pass the current value through untouched; the
 * main-process clamp still guards the wire value.
 */
export function resolveModelStrength (
  capabilities: ReasoningCapabilityFields | undefined,
  { remembered, current = '' }: { remembered?: string; current?: string }
): ResolvedModelStrength {
  const declared = capabilities?.reasoningEfforts
  const allowed = capabilities?.allowedReasoningEfforts
  let supported: string[] | undefined = declared
  if (allowed?.length && declared?.length) {
    const intersected = allowed.filter(level => declared.includes(level))
    supported = intersected.length > 0 ? intersected : declared
  } else if (allowed?.length) {
    supported = allowed
  }

  const accepts = (value: string | undefined): value is string => {
    return typeof value === 'string' && value.length > 0 &&
      (!supported || supported.length === 0 || supported.includes(value))
  }

  const levels = orderLevels(supported?.length ? supported : [...REASONING_EFFORT_ORDER])
  const resolved = [remembered, capabilities?.reasoningEffort, capabilities?.defaultReasoningEffort].find(accepts)
  const active = resolved ?? (accepts(current) ? current : clampReasoningEffort(current, supported))
  return { levels, active }
}

/** Known levels sort weak→strong; unknown gateway strings keep order, after. */
function orderLevels (levels: string[]): string[] {
  const known = levels
    .filter(level => REASONING_EFFORT_ORDER.includes(level))
    .sort((left, right) => REASONING_EFFORT_ORDER.indexOf(left) - REASONING_EFFORT_ORDER.indexOf(right))
  const unknown = levels.filter(level => !REASONING_EFFORT_ORDER.includes(level))
  return [...known, ...unknown]
}
