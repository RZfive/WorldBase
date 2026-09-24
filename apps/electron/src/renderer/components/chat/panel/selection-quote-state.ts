/**
 * Renderer-side store for "add selection to context" quotes.
 *
 * When the user selects conversation text and picks 加入上下文, the text is
 * parked here under a generated id and a `[[sel:<id>|<label>]]` tag is
 * appended to the composer draft - ChatInput renders the tag as a capsule
 * chip, and the message sender expands the stored text into the outgoing
 * prompt at send time. Entries are transient draft state: consumed on send,
 * removed with their chip, and never persisted.
 */
const selectionQuoteTexts = new Map<string, string>()

export const SELECTION_QUOTE_TAG_PATTERN = /\[\[sel:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g

function excerptLabel (text: string, limit = 18): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit)}…`
}

/** Parks the text and returns the tag to append to the composer draft. */
export function addSelectionQuote (text: string): string {
  const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  selectionQuoteTexts.set(id, text)
  return `[[sel:${id}|${excerptLabel(text)}]]`
}

export function getSelectionQuoteText (id: string): string | undefined {
  return selectionQuoteTexts.get(id)
}

export function removeSelectionQuote (id: string): void {
  selectionQuoteTexts.delete(id)
}

/** Drops quote entries whose tag is no longer present in the draft. */
export function pruneSelectionQuotes (presentIds: Iterable<string>): void {
  const alive = new Set(presentIds)
  for (const id of selectionQuoteTexts.keys()) {
    if (!alive.has(id)) selectionQuoteTexts.delete(id)
  }
}
