let mermaidModulePromise: Promise<typeof import('mermaid').default> | null = null
let mermaidInitialized = false
let mermaidRenderCount = 0

export interface MarkdownSegment {
  type: 'markdown' | 'mermaid'
  text: string
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
  const mermaid = await getMermaid()
  const hasRandomUuid = typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
  const diagramId = hasRandomUuid
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${mermaidRenderCount++}`
  const { svg } = await mermaid.render(`chat-mermaid-diagram-${diagramId}`, code.trim())
  return svg
}
