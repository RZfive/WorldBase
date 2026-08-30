/**
 * Word (docx) → DocumentNode[] parser.
 * Reads OOXML paragraphs so editor nodes retain stable source locations.
 */
import { DOMParser } from '@xmldom/xmldom'
import JSZip from 'jszip'
import type { DocumentNode } from './document-types.js'

let nodeCounter = 0
function nextId (): string {
  return `doc_${++nodeCounter}`
}

export async function parseWordToNodes (buffer: Buffer): Promise<DocumentNode[]> {
  nodeCounter = 0
  const zip = await JSZip.loadAsync(buffer)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error('The DOCX file is missing word/document.xml')
  const document = new DOMParser().parseFromString(documentXml, 'application/xml')
  const paragraphs = Array.from(document.getElementsByTagName('w:p'))
  const nodes: DocumentNode[] = []
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const text = Array.from(paragraph.getElementsByTagName('w:t'))
      .map(textNode => textNode.textContent || '')
      .join('')
    if (!text.trim()) continue

    const styleElement = paragraph.getElementsByTagName('w:pStyle')[0]
    const styleValue = styleElement?.getAttribute('w:val') || styleElement?.getAttribute('val') || ''
    const headingMatch = /heading\s*([1-6])/i.exec(styleValue)
    const isHeading = Boolean(headingMatch)
    const isList = paragraph.getElementsByTagName('w:numPr').length > 0

    nodes.push({
      id: nextId(),
      type: isHeading ? 'heading' : isList ? 'list_item' : 'paragraph',
      text,
      level: isHeading ? Number(headingMatch?.[1] || 1) : 0,
      pageIndex: 1,
      meta: {
        docxPart: 'word/document.xml',
        docxParagraphIndex: paragraphIndex,
        paragraphStyle: styleValue
      }
    })
  }

  return nodes
}
