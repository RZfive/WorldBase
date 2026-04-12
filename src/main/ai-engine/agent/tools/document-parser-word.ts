/**
 * Word (docx) → DocumentNode[] parser.
 * Uses mammoth to extract structured content with heading detection.
 */
import mammoth from 'mammoth'
import type { DocumentNode } from './document-types.js'

const MAX_TEXT_LENGTH = 100000

let nodeCounter = 0
function nextId (): string {
  return `doc_${++nodeCounter}`
}

export async function parseWordToNodes (buffer: Buffer): Promise<DocumentNode[]> {
  nodeCounter = 0
  const result = await mammoth.extractRawText({ buffer })
  const text = result.value || ''

  // Also attempt to get HTML to detect headings
  const htmlResult = await mammoth.convertToHtml({ buffer })
  const html = htmlResult.value || ''

  const nodes: DocumentNode[] = []
  let pageIdx = 1

  // Extract headings from HTML for structure
  const headingRegex = /<h(\d)[^>]*>([\s\S]*?)<\/h\1>/gi
  const headings: Array<{ level: number; text: string; index: number }> = []
  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(html)) !== null) {
    const headingText = match[2].replace(/<[^>]+>/g, '').trim()
    if (headingText) {
      headings.push({ level: parseInt(match[1], 10), text: headingText, index: match.index })
    }
  }

  // Split raw text into paragraphs
  const rawParagraphs = text.split(/\n+/).filter(p => p.trim())
  let truncated = false
  let charCount = 0

  for (const para of rawParagraphs) {
    if (charCount + para.length > MAX_TEXT_LENGTH) {
      truncated = true
      break
    }
    charCount += para.length

    // Check if this paragraph matches a heading
    const headingMatch = headings.find(h => para.trim().startsWith(h.text.substring(0, 20)))
    const isHeading = Boolean(headingMatch)

    nodes.push({
      id: nextId(),
      type: isHeading ? 'heading' : 'paragraph',
      text: para.trim(),
      level: isHeading ? (headingMatch!.level) : 0,
      pageIndex: pageIdx
    })
  }

  if (truncated) {
    nodes.push({
      id: nextId(),
      type: 'paragraph',
      text: `... 内容已截断 (共 ${text.length} 字符)`,
      level: 0,
      pageIndex: pageIdx
    })
  }

  return nodes
}
