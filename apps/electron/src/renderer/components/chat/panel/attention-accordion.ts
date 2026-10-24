import { computed, ref, watch, type Ref } from 'vue'

export type AttentionPanelId = 'auth' | 'sudo' | 'ask' | 'todo'

/** Priority order for auto-expansion. Todo is passive background info and is
 * never auto-expanded; actionable requests surface in this order. */
const AUTO_EXPAND_PRIORITY: AttentionPanelId[] = ['auth', 'sudo', 'ask']

/**
 * One-expanded-at-a-time state for the chat-attention-zone (design v1.7:
 * auth / sudo / ask / todo capsules). Instead of stacking every pending
 * panel expanded — which pushed the pile arbitrarily far up the message
 * list — exactly one panel shows its detail and the rest stay as collapsed
 * strips.
 *
 * `pending` lists the panel ids currently mounted, `signature` must change
 * whenever that set or any request id inside it changes; a signature change
 * clears the user's pick so the next actionable request surfaces again.
 */
export function createAttentionAccordion (
  pending: () => AttentionPanelId[],
  signature: Ref<string> | (() => string)
) {
  /** null = follow the priority default; 'none' = user collapsed everything;
   * otherwise the panel the user picked on the strip. */
  const userPick = ref<AttentionPanelId | 'none' | null>(null)

  watch(signature, () => {
    userPick.value = null
  })

  const expandedPanel = computed<AttentionPanelId | null>(() => {
    const ids = pending()
    const pick = userPick.value
    if (pick === 'none') return null
    if (pick && ids.includes(pick)) return pick
    for (const id of AUTO_EXPAND_PRIORITY) {
      if (ids.includes(id)) return id
    }
    return null
  })

  function togglePanel (id: AttentionPanelId): void {
    userPick.value = expandedPanel.value === id ? 'none' : id
  }

  return { expandedPanel, togglePanel }
}
