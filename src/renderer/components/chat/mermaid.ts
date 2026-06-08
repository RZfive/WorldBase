let mermaidModulePromise: Promise<typeof import('mermaid').default> | null = null
let mermaidInitialized = false
let mermaidRenderCount = 0

export interface MarkdownSegment {
  type: 'markdown' | 'mermaid'
  text: string
}

export interface MermaidRender {
  /** Rendered SVG markup, keyed by the diagram code. */
  svg: string
  /** Root diagram id baked into the SVG; replace it to namespace per instance. */
  id: string
}

// Diagrams are deterministic for a given code block, so memoize the rendered SVG.
// The virtual message list re-mounts rows as they scroll in and out of view; without
// this cache every re-mount would re-run the async render (placeholder -> SVG), which
// changes the row height after measurement and makes the list jump while scrolling.
const MERMAID_CACHE_LIMIT = 60
const mermaidRenderCache = new Map<string, MermaidRender>()
const mermaidInflight = new Map<string, Promise<MermaidRender>>()

function rememberMermaidRender (key: string, render: MermaidRender): MermaidRender {
  if (mermaidRenderCache.has(key)) mermaidRenderCache.delete(key)
  mermaidRenderCache.set(key, render)
  while (mermaidRenderCache.size > MERMAID_CACHE_LIMIT) {
    const oldest = mermaidRenderCache.keys().next().value
    if (oldest === undefined) break
    mermaidRenderCache.delete(oldest)
  }
  return render
}

const MERMAID_BLOCK_RE = /```mermaid\s*\r?\n([\s\S]*?)```/gi

export function splitMarkdownWithMermaid (text: string): MarkdownSegment[] {
  if (!text) return []

  const segments: MarkdownSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(MERMAID_BLOCK_RE)) {
    const matchIndex = match.index ?? 0
    if (matchIndex > lastIndex) {
      const markdown = text.slice(lastIndex, matchIndex)
      if (markdown.trim()) segments.push({ type: 'markdown', text: markdown })
    }

    const mermaidCode = match[1]?.trim()
    if (mermaidCode) segments.push({ type: 'mermaid', text: mermaidCode })
    lastIndex = matchIndex + match[0].length
  }

  if (lastIndex < text.length) {
    const markdown = text.slice(lastIndex)
    if (markdown.trim()) segments.push({ type: 'markdown', text: markdown })
  }

  return segments.length > 0 ? segments : [{ type: 'markdown', text }]
}

async function getMermaid () {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then(module => module.default)
  }

  const mermaid = await mermaidModulePromise
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    })
    mermaidInitialized = true
  }
  return mermaid
}

export async function renderMermaidSvg (code: string): Promise<string> {
  return (await renderMermaid(code)).svg
}

/**
 * Synchronously return a previously rendered diagram, if any. Lets callers paint a
 * recycled row at its final height on mount (no async placeholder -> SVG resize).
 */
export function getCachedMermaid (code: string): MermaidRender | null {
  return mermaidRenderCache.get(code.trim()) ?? null
}

export async function renderMermaid (code: string): Promise<MermaidRender> {
  const key = code.trim()
  const cached = mermaidRenderCache.get(key)
  if (cached) return cached

  const inflight = mermaidInflight.get(key)
  if (inflight) return inflight

  const promise = (async (): Promise<MermaidRender> => {
    const mermaid = await getMermaid()
    const hasRandomUuid = typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
    const diagramId = hasRandomUuid
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${mermaidRenderCount++}`
    const id = `chat-mermaid-diagram-${diagramId}`
    const { svg } = await mermaid.render(id, key)
    return rememberMermaidRender(key, { svg, id })
  })()

  mermaidInflight.set(key, promise)
  try {
    return await promise
  } finally {
    mermaidInflight.delete(key)
  }
}
