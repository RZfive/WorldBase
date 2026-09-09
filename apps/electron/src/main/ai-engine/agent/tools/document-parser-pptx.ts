/**
 * PowerPoint (pptx) → DocumentNode[] parser.
 * Extracts slide text from XML via JSZip.
 */
import type { DocumentNode } from './document-types.js'

let nodeCounter = 0
function nextId (): string {
  return `ppt_${++nodeCounter}`
}

function extractParagraphsFromXml (xml: string): string[] {
  const paragraphs: string[] = []
  const pRegex = /<a:p[\s>][\s\S]*?<\/a:p>/g
  let pMatch: RegExpExecArray | null
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pContent = pMatch[0]
    const textParts: string[] = []
    const tRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = tRegex.exec(pContent)) !== null) {
      textParts.push(tMatch[1].trim())
    }
    const line = textParts.join('')
    if (line.trim()) paragraphs.push(line.trim())
  }
  return paragraphs
}

export async function parsePptxToNodes (buffer: Buffer): Promise<DocumentNode[]> {
  nodeCounter = 0
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buffer)

  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0', 10)
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0', 10)
      return numA - numB
    })

  const nodes: DocumentNode[] = []

  for (let i = 0; i < slideFiles.length; i++) {
    const xmlContent = await zip.files[slideFiles[i]].async('text')
    const paragraphs = extractParagraphsFromXml(xmlContent)

    const slideNode: DocumentNode = {
      id: nextId(),
      type: 'slide',
      text: `幻灯片 ${i + 1}`,
      level: 0,
      pageIndex: i + 1,
      children: []
    }

    for (const para of paragraphs) {
      slideNode.children!.push({
        id: nextId(),
        type: 'paragraph',
        text: para,
        level: 1,
        pageIndex: i + 1
      })
    }

    if (slideNode.children!.length === 0) {
      slideNode.children!.push({
        id: nextId(),
        type: 'paragraph',
        text: '(无文本内容)',
        level: 1,
        pageIndex: i + 1
      })
    }

    nodes.push(slideNode)
  }

  return nodes
}
