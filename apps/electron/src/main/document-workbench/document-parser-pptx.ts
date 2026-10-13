/**
 * PowerPoint (pptx) → DocumentNode[] parser.
 * Extracts slide text from XML via JSZip.
 */
import type { DocumentNode } from './document-types.js'

let nodeCounter = 0
function nextId (): string {
  return `ppt_${++nodeCounter}`
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

    // 段落索引：页内 document 序 `<a:p>` 序号（含空段落），与 Rust 端
    // paragraphItems 对齐，doc_draft ops 用它做手术定位。
    let paragraphCursor = 0
    const paragraphIndexes: number[] = []
    const pRegex = /<a:p[\s>][\s\S]*?<\/a:p>|<a:p\/>/g
    let pMatch: RegExpExecArray | null
    const paragraphTexts: string[] = []
    while ((pMatch = pRegex.exec(xmlContent)) !== null) {
      const element = pMatch[0]
      const textParts: string[] = []
      const tRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g
      let tMatch: RegExpExecArray | null
      while ((tMatch = tRegex.exec(element)) !== null) {
        textParts.push(tMatch[1].trim())
      }
      const line = textParts.join('')
      if (line.trim()) {
        paragraphIndexes.push(paragraphCursor)
        paragraphTexts.push(line.trim())
      }
      paragraphCursor += 1
    }

    // 图片占位：经 slide rels 解析 r:embed 引用的 media 部件。
    const relsName = slideFiles[i].replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels'
    const relsXml = await zip.file(relsName)?.async('text') || ''
    const mediaByRid = new Map<string, string>()
    const relRegex = /<Relationship [^>]*>/g
    let relMatch: RegExpExecArray | null
    while ((relMatch = relRegex.exec(relsXml)) !== null) {
      const id = /Id="([^"]+)"/.exec(relMatch[0])?.[1]
      const target = /Target="([^"]+)"/.exec(relMatch[0])?.[1]
      if (id && target) {
        mediaByRid.set(id, target.replace(/^\.\.\//, 'ppt/').replace(/^\//, ''))
      }
    }
    const slideMedia = new Set<string>()
    const blipRegex = /r:(?:embed|link)="([^"]+)"/g
    let blipMatch: RegExpExecArray | null
    while ((blipMatch = blipRegex.exec(xmlContent)) !== null) {
      const target = mediaByRid.get(blipMatch[1])
      if (target && /\/media\//i.test(target)) slideMedia.add(target)
    }

    const slideNode: DocumentNode = {
      id: nextId(),
      type: 'slide',
      text: `幻灯片 ${i + 1}`,
      level: 0,
      pageIndex: i + 1,
      children: []
    }

    for (const [paragraphIndex, para] of paragraphTexts.entries()) {
      slideNode.children!.push({
        id: nextId(),
        type: 'paragraph',
        text: para,
        level: 1,
        pageIndex: i + 1,
        meta: { pptxSlideParagraphIndex: paragraphIndexes[paragraphIndex] }
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

    // 图片占位节点追加在段落之后，保持段落节点 id 稳定。
    for (const mediaPath of [...slideMedia].sort()) {
      slideNode.children!.push({
        id: nextId(),
        type: 'image_placeholder',
        text: mediaPath.split('/').pop() || mediaPath,
        level: 1,
        pageIndex: i + 1,
        meta: { mediaPath }
      })
    }

    nodes.push(slideNode)
  }

  return nodes
}
