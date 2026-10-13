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

  // 图片占位节点：让 AI 与变更清单"看得见"图片（追加在段落之后，段落
  // 节点 id 保持稳定）。media 部件存在即占位，不区分是否被正文引用。
  const mediaNames = Object.keys(zip.files)
    .filter(name => /^word\/media\/.+/i.test(name))
    .sort()
  for (const mediaPath of mediaNames) {
    const fileName = mediaPath.split('/').pop() || mediaPath
    nodes.push({
      id: nextId(),
      type: 'image_placeholder',
      text: fileName,
      level: 0,
      pageIndex: 1,
      meta: { mediaPath }
    })
  }

  return nodes
}
