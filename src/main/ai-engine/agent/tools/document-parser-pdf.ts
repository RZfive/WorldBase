/**
 * PDF → DocumentNode[] parser.
 * Uses pdf-parse v2 (PDFParse class) to extract text per page.
 */
import type { DocumentNode } from './document-types.js'

let nodeCounter = 0
function nextId (): string {
  return `pdf_${++nodeCounter}`
}

export async function parsePdfToNodes (buffer: Buffer): Promise<DocumentNode[]> {
  nodeCounter = 0
  const { PDFParse } = await import('pdf-parse')

  const parser = new PDFParse({ data: buffer })
  const result = await parser.getText()

  const nodes: DocumentNode[] = []

  for (const page of result.pages) {
    const pageNode: DocumentNode = {
      id: nextId(),
      type: 'page',
      text: `第 ${page.num} 页`,
      level: 0,
      pageIndex: page.num,
      children: []
    }

    // Split page text into paragraphs by double newlines
    const paragraphs = (page.text || '')
      .split(/\n{2,}/)
      .map((p: string) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)

    if (paragraphs.length === 0) {
      pageNode.children!.push({
        id: nextId(),
        type: 'paragraph',
        text: (page.text || '').trim() || '(无文本内容)',
        level: 1,
        pageIndex: page.num
      })
    } else {
      for (const para of paragraphs) {
        pageNode.children!.push({
          id: nextId(),
          type: 'paragraph',
          text: para,
          level: 1,
          pageIndex: page.num
        })
      }
    }

    nodes.push(pageNode)
  }

  // Cleanup
  parser.destroy()

  return nodes
}
