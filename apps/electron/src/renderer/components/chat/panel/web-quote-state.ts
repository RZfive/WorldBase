/**
 * Renderer-side store for "add web page content to context" quotes.
 *
 * When the user right-clicks a selection or an element inside an in-app
 * browser page and picks 加入上下文, the captured text is parked here under
 * a generated id and a `[[web:<id>|<label>]]` tag is appended to the
 * composer draft - ChatInput renders the tag as a capsule chip, and the
 * message sender expands the stored content into the outgoing prompt at
 * send time. Entries are transient draft state: consumed on send, removed
 * with their chip, and never persisted.
 */
export interface WebQuoteEntry {
  url: string
  title: string
  kind: 'selection' | 'element'
  text: string
  selector?: string
  tag?: string
}

const webQuoteEntries = new Map<string, WebQuoteEntry>()

export const WEB_QUOTE_TAG_PATTERN = /\[\[web:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g

function excerptLabel (text: string, limit = 18): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit)}…`
}

/** Parks the captured page content and returns the tag to append to the composer draft. */
export function addWebQuote (entry: WebQuoteEntry): string {
  const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  webQuoteEntries.set(id, entry)
  const label = excerptLabel(entry.text || entry.title || entry.url)
  return `[[web:${id}|${label}]]`
}

export function getWebQuote (id: string): WebQuoteEntry | undefined {
  return webQuoteEntries.get(id)
}

export function removeWebQuote (id: string): void {
  webQuoteEntries.delete(id)
}

/** Drops quote entries whose tag is no longer present in the draft. */
export function pruneWebQuotes (presentIds: Iterable<string>): void {
  const alive = new Set(presentIds)
  for (const id of webQuoteEntries.keys()) {
    if (!alive.has(id)) webQuoteEntries.delete(id)
  }
}

export function extractWebQuoteRefs (text: string, pattern: RegExp = WEB_QUOTE_TAG_PATTERN): { quoteIds: string[]; normalizedText: string } {
  const quoteIds: string[] = []
  const normalizedText = text.replace(pattern, (_match, quoteId: string, rawLabel?: string) => {
    if (!quoteIds.includes(quoteId)) quoteIds.push(quoteId)
    const label = rawLabel?.trim() || '网页引用'
    return `网页引用「${label}」`
  }).replace(/\n{3,}/g, '\n\n')

  return { quoteIds, normalizedText }
}

/** Builds the prompt block that carries captured in-app browser page content into the model context. */
export function buildWebQuotesPrompt (quoteIds: string[]): string {
  const blocks: string[] = []
  for (const id of quoteIds) {
    const entry = webQuoteEntries.get(id)
    if (!entry?.text) continue
    const heading = entry.kind === 'element' ? '网页元素引用' : '网页引用'
    const source = [entry.title, entry.url].filter(Boolean).join(' — ')
    const lines = [`【${heading}：${source || entry.url}】`]
    if (entry.selector) {
      lines.push(`（元素：<${entry.tag || 'element'}> ${entry.selector}）`)
    }
    lines.push(entry.text)
    lines.push('【引用结束】')
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}
