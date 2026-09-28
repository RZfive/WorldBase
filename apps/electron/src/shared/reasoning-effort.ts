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
