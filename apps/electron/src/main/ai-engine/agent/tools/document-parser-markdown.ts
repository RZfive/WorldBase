/**
 * Markdown → DocumentNode[] parser.
 * Produces heading / paragraph / list_item / table nodes so AI document reads
 * and the structured fallback view work exactly like the office formats; the
 * real user-facing preview reuses the chat Markdown renderer in the renderer
 * process (render kind `markdown`).
 */
import { marked } from 'marked'
import type { DocumentNode } from './document-types.js'

/** Hard ceiling so a pathological file cannot balloon the artifact. */
const MAX_NODES = 20000

let nodeCounter = 0

function nextId (): string {
  return `md_${++nodeCounter}`
}

function baseNode (type: DocumentNode['type'], text: string, extra?: { level?: number; pageIndex?: number; meta?: Record<string, unknown> }): DocumentNode {
  return {
    id: nextId(),
    type,
    text,
    level: extra?.level ?? 0,
    pageIndex: extra?.pageIndex ?? 1,
    ...(extra?.meta ? { meta: extra.meta } : {})
  }
}

interface MarkedTokenLike {
  type: string
  raw?: string
  text?: string
  depth?: number
  lang?: string
  tokens?: MarkedTokenLike[]
  items?: MarkedTokenLike[]
  header?: Array<{ text?: string }>
  rows?: Array<Array<{ text?: string }>>
}

function cellText (cell: { text?: string } | undefined): string {
  return (cell?.text ?? '').replace(/\s+/g, ' ').trim()
}

function pushTokens (tokens: MarkedTokenLike[] | undefined, out: DocumentNode[]): void {
  for (const token of tokens || []) {
    if (out.length >= MAX_NODES) return
    switch (token.type) {
      case 'heading':
        out.push(baseNode('heading', token.text ?? '', { level: Math.max(1, Math.min(6, token.depth ?? 1)) }))
        break
      case 'paragraph':
        if ((token.text ?? '').trim()) out.push(baseNode('paragraph', token.text ?? ''))
        break
      case 'code':
        out.push(baseNode('paragraph', token.text ?? '', { meta: token.lang ? { lang: token.lang } : undefined }))
        break
      case 'table': {
        const headers = (token.header || []).map(cellText)
        const table = baseNode('table', headers.join(' | '), {
          meta: { headers }
        })
        table.children = []
        for (const row of token.rows || []) {
          if (out.length >= MAX_NODES) break
          const cells = row.map(cellText)
          table.children.push({
            id: nextId(),
            type: 'table_row',
            text: cells.join(' | '),
            level: 1,
            pageIndex: 1,
            meta: { cells }
          })
        }
        out.push(table)
        break
      }
      case 'list':
        for (const item of token.items || []) {
          if (out.length >= MAX_NODES) break
          const itemText = (item.text ?? '').replace(/\s+/g, ' ').trim()
          if (itemText) out.push(baseNode('list_item', itemText))
          // nested lists / paragraphs inside the item
          pushTokens(item.tokens, out)
        }
        break
      case 'blockquote':
      case 'space':
      case 'hr':
      default:
        pushTokens(token.tokens, out)
        break
    }
  }
}

export function parseMarkdownToNodes (source: string | Buffer): DocumentNode[] {
  nodeCounter = 0
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : source
  const nodes: DocumentNode[] = []
  pushTokens(marked.lexer(text) as unknown as MarkedTokenLike[], nodes)
  return nodes
}
