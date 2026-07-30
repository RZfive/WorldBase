import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode
} from '@xmldom/xmldom'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import sharp from 'sharp'
import type {
  DocumentEditImagePayload,
  DocumentEditOperation,
  DocxInsertImageOperation,
  DocxReplaceTextOperation,
  NormalizedDocumentRect,
  PdfInsertImageOperation,
  PdfReplaceTextOperation
} from '../../shared/document-edit-types.js'

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'
const IMAGE_RELATIONSHIP_TYPE = `${OFFICE_RELATIONSHIP_NAMESPACE}/image`
const EMU_PER_INCH = 914400

function clamp (value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeRect (rect: NormalizedDocumentRect): NormalizedDocumentRect {
  const x = clamp(Number(rect.x) || 0, 0, 1)
  const y = clamp(Number(rect.y) || 0, 0, 1)
  return {
    x,
    y,
    width: clamp(Number(rect.width) || 0.1, 0.01, 1 - x),
    height: clamp(Number(rect.height) || 0.04, 0.01, 1 - y)
  }
}

function parseHexColor (value: string, fallback: string): ReturnType<typeof rgb> {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
  return rgb(
    parseInt(normalized.slice(1, 3), 16) / 255,
    parseInt(normalized.slice(3, 5), 16) / 255,
    parseInt(normalized.slice(5, 7), 16) / 255
  )
}

function isWinAnsiText (value: string): boolean {
  return /^[\x00-\xff]*$/.test(value)
}

async function findUnicodeFontPath (): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'Deng.ttf'),
        path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'simhei.ttf')
      ]
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf']
      : [
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
        ]

  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Continue to the next system font candidate.
    }
  }
  return null
}

async function embedTextFont (document: PDFDocument, text: string): Promise<PDFFont> {
  if (isWinAnsiText(text)) {
    return document.embedFont(StandardFonts.Helvetica)
  }

  const fontPath = await findUnicodeFontPath()
  if (!fontPath) {
    throw new Error('No Unicode font is available for the edited PDF text')
  }

  document.registerFontkit(fontkit)
  return document.embedFont(await fs.readFile(fontPath), { subset: true })
}

function wrapText (text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const sourceLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!sourceLine) {
      lines.push('')
      continue
    }

    let current = ''
    for (const character of sourceLine) {
      const candidate = `${current}${character}`
      if (current && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
        lines.push(current)
        current = character
      } else {
        current = candidate
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

function resolvePdfRect (page: PDFPage, input: NormalizedDocumentRect) {
  const rect = normalizeRect(input)
  const { width: pageWidth, height: pageHeight } = page.getSize()
  const width = rect.width * pageWidth
  const height = rect.height * pageHeight
  return {
    x: rect.x * pageWidth,
    y: pageHeight - ((rect.y + rect.height) * pageHeight),
    width,
    height
  }
}

async function applyPdfTextOperation (document: PDFDocument, operation: PdfReplaceTextOperation): Promise<void> {
  const page = document.getPage(operation.pageIndex - 1)
  if (!page) throw new Error(`PDF page ${operation.pageIndex} does not exist`)

  const rect = resolvePdfRect(page, operation.rect)
  const fontSize = clamp(operation.fontSize || 12, 6, 72)
  const font = await embedTextFont(document, operation.afterText)
  const lineHeight = fontSize * 1.18

  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: parseHexColor(operation.backgroundColor, '#ffffff')
  })

  const lines = wrapText(operation.afterText, font, fontSize, Math.max(4, rect.width - 4))
  let y = rect.y + rect.height - fontSize
  for (const line of lines) {
    if (y < rect.y) break
    page.drawText(line, {
      x: rect.x + 2,
      y,
      size: fontSize,
      font,
      color: parseHexColor(operation.color, '#111827'),
      maxWidth: Math.max(4, rect.width - 4)
    })
    y -= lineHeight
  }
}

async function embedPdfImage (document: PDFDocument, image: DocumentEditImagePayload) {
  const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes)
  return image.mimeType === 'image/png'
    ? document.embedPng(bytes)
    : document.embedJpg(bytes)
}

async function applyPdfImageOperation (document: PDFDocument, operation: PdfInsertImageOperation): Promise<void> {
  const page = document.getPage(operation.pageIndex - 1)
  if (!page) throw new Error(`PDF page ${operation.pageIndex} does not exist`)
  const rect = resolvePdfRect(page, operation.rect)
  const image = await embedPdfImage(document, operation.image)
  page.drawImage(image, {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    rotate: degrees(0)
  })
}

async function exportPdfCopy (sourcePath: string, outputPath: string, operations: DocumentEditOperation[]): Promise<void> {
  const document = await PDFDocument.load(await fs.readFile(sourcePath), { updateMetadata: false })
  for (const operation of operations) {
    if (operation.type === 'pdf_replace_text') {
      await applyPdfTextOperation(document, operation)
    } else if (operation.type === 'pdf_insert_image') {
      await applyPdfImageOperation(document, operation)
    }
  }
  await atomicWriteFile(outputPath, Buffer.from(await document.save()))
}

function getAttribute (element: XmlElement, qualifiedName: string, localName: string): string {
  return element.getAttribute(qualifiedName) || element.getAttribute(localName) || ''
}

function setWordText (paragraph: XmlElement, value: string): void {
  const textNodes = Array.from(paragraph.getElementsByTagName('w:t'))
  if (textNodes.length === 0) {
    const run = paragraph.ownerDocument!.createElementNS(WORD_NAMESPACE, 'w:r')
    const text = paragraph.ownerDocument!.createElementNS(WORD_NAMESPACE, 'w:t')
    run.appendChild(text)
    paragraph.appendChild(run)
    textNodes.push(text)
  }

  const first = textNodes[0]
  while (first.firstChild) first.removeChild(first.firstChild)
  first.appendChild(paragraph.ownerDocument!.createTextNode(value))
  first.setAttribute('xml:space', 'preserve')

  for (const textNode of textNodes.slice(1)) {
    while (textNode.firstChild) textNode.removeChild(textNode.firstChild)
  }
}

function nextRelationshipId (relationships: XmlElement[]): string {
  const used = new Set(relationships.map(item => getAttribute(item, 'Id', 'Id')))
  let index = 1
  while (used.has(`rId${index}`)) index++
  return `rId${index}`
}

function nextMediaName (zip: JSZip, extension: string): string {
  let index = 1
  while (zip.file(`word/media/edit-image-${index}.${extension}`)) index++
  return `edit-image-${index}.${extension}`
}

function ensureImageContentType (contentTypesDocument: XmlDocument, extension: string, mimeType: string): void {
  const defaults = Array.from(contentTypesDocument.getElementsByTagName('Default'))
  if (defaults.some(item => getAttribute(item, 'Extension', 'Extension').toLowerCase() === extension)) return
  const element = contentTypesDocument.createElementNS(CONTENT_TYPES_NAMESPACE, 'Default')
  element.setAttribute('Extension', extension)
  element.setAttribute('ContentType', mimeType)
  if (!contentTypesDocument.documentElement) throw new Error('Invalid DOCX content types XML')
  contentTypesDocument.documentElement.appendChild(element)
}

function createImageParagraph (
  document: XmlDocument,
  relationshipId: string,
  fileName: string,
  widthEmu: number,
  heightEmu: number,
  drawingId: number
): XmlNode {
  const parser = new DOMParser()
  const imageDocument = parser.parseFromString([
    `<w:p xmlns:w="${WORD_NAMESPACE}" xmlns:r="${OFFICE_RELATIONSHIP_NAMESPACE}">`,
    '<w:r><w:drawing>',
    `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">`,
    `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>`,
    `<wp:docPr id="${drawingId}" name="${escapeXml(fileName)}"/>`,
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    `<pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${escapeXml(fileName)}"/><pic:cNvPicPr/></pic:nvPicPr>`,
    `<pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`,
    '</pic:pic></a:graphicData></a:graphic>',
    '</wp:inline></w:drawing></w:r></w:p>'
  ].join(''), 'application/xml')
  if (!imageDocument.documentElement) throw new Error('Failed to build the DOCX image element')
  return document.importNode(imageDocument.documentElement, true)
}

function escapeXml (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function applyDocxImageOperation (
  zip: JSZip,
  document: XmlDocument,
  relationshipsDocument: XmlDocument,
  contentTypesDocument: XmlDocument,
  paragraphs: XmlElement[],
  operation: DocxInsertImageOperation,
  drawingId: number
): Promise<void> {
  const anchor = paragraphs[operation.paragraphIndex]
  if (!anchor?.parentNode) throw new Error(`Word paragraph ${operation.paragraphIndex} does not exist`)

  const relationshipsRoot = relationshipsDocument.documentElement
  if (!relationshipsRoot) throw new Error('Invalid DOCX relationships XML')
  const relationshipElements = Array.from(relationshipsDocument.getElementsByTagName('Relationship'))
  const relationshipId = nextRelationshipId(relationshipElements)
  const extension = operation.image.mimeType === 'image/png' ? 'png' : 'jpg'
  const mediaName = nextMediaName(zip, extension)
  const bytes = operation.image.bytes instanceof Uint8Array ? operation.image.bytes : new Uint8Array(operation.image.bytes)
  zip.file(`word/media/${mediaName}`, bytes)

  const relationship = relationshipsDocument.createElementNS(RELATIONSHIP_NAMESPACE, 'Relationship')
  relationship.setAttribute('Id', relationshipId)
  relationship.setAttribute('Type', IMAGE_RELATIONSHIP_TYPE)
  relationship.setAttribute('Target', `media/${mediaName}`)
  relationshipsRoot.appendChild(relationship)
  ensureImageContentType(contentTypesDocument, extension, operation.image.mimeType)

  const metadata = await sharp(Buffer.from(bytes)).metadata()
  const sourceWidth = metadata.width || operation.image.width || 1
  const sourceHeight = metadata.height || operation.image.height || 1
  const widthInches = clamp(operation.widthInches || 4, 0.5, 6.5)
  const heightInches = widthInches * (sourceHeight / sourceWidth)
  const imageParagraph = createImageParagraph(
    document,
    relationshipId,
    mediaName,
    Math.round(widthInches * EMU_PER_INCH),
    Math.round(heightInches * EMU_PER_INCH),
    drawingId
  )
  anchor.parentNode.insertBefore(imageParagraph, anchor.nextSibling)
}

async function exportDocxCopy (sourcePath: string, outputPath: string, operations: DocumentEditOperation[]): Promise<void> {
  const zip = await JSZip.loadAsync(await fs.readFile(sourcePath))
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error('The DOCX file is missing word/document.xml')

  const relationshipPath = 'word/_rels/document.xml.rels'
  const relationshipsXml = await zip.file(relationshipPath)?.async('string')
    || `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELATIONSHIP_NAMESPACE}"/>`
  const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string')
  if (!contentTypesXml) throw new Error('The DOCX file is missing [Content_Types].xml')

  const parser = new DOMParser()
  const document = parser.parseFromString(documentXml, 'application/xml')
  const relationshipsDocument = parser.parseFromString(relationshipsXml, 'application/xml')
  const contentTypesDocument = parser.parseFromString(contentTypesXml, 'application/xml')
  const paragraphs = Array.from(document.getElementsByTagName('w:p'))

  for (const operation of operations) {
    if (operation.type !== 'docx_replace_text') continue
    const paragraph = paragraphs[operation.paragraphIndex]
    if (!paragraph) throw new Error(`Word paragraph ${operation.paragraphIndex} does not exist`)
    setWordText(paragraph, operation.afterText)
  }

  const imageOperations = operations
    .filter((operation): operation is DocxInsertImageOperation => operation.type === 'docx_insert_image')
    .sort((left, right) => right.paragraphIndex - left.paragraphIndex)
  let drawingId = 10000
  for (const operation of imageOperations) {
    await applyDocxImageOperation(
      zip,
      document,
      relationshipsDocument,
      contentTypesDocument,
      paragraphs,
      operation,
      drawingId++
    )
  }

  const serializer = new XMLSerializer()
  zip.file('word/document.xml', serializer.serializeToString(document))
  zip.file(relationshipPath, serializer.serializeToString(relationshipsDocument))
  zip.file('[Content_Types].xml', serializer.serializeToString(contentTypesDocument))
  await atomicWriteFile(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

async function atomicWriteFile (outputPath: string, content: Buffer): Promise<void> {
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, content)
    await fs.rename(temporaryPath, outputPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

export async function calculateDocumentSha256 (filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

export async function readDocumentEditImage (filePath: string): Promise<DocumentEditImagePayload> {
  const bytes = await fs.readFile(filePath)
  const metadata = await sharp(bytes).metadata()
  const mimeType = metadata.format === 'png' ? 'image/png' : metadata.format === 'jpeg' ? 'image/jpeg' : null
  if (!mimeType) throw new Error('Only PNG and JPEG images are supported')
  return {
    fileName: path.basename(filePath),
    mimeType,
    bytes: new Uint8Array(bytes),
    width: metadata.width || 1,
    height: metadata.height || 1
  }
}

export async function exportDocumentCopy (
  sourcePath: string,
  outputPath: string,
  fileType: 'pdf' | 'docx',
  operations: DocumentEditOperation[]
): Promise<void> {
  if (path.resolve(sourcePath).toLowerCase() === path.resolve(outputPath).toLowerCase()) {
    throw new Error('The edited document must be saved as a copy')
  }
  if (operations.length === 0) throw new Error('There are no document changes to save')

  if (fileType === 'pdf') {
    if (operations.some(operation => !operation.type.startsWith('pdf_'))) {
      throw new Error('The edit session contains operations for another document format')
    }
    await exportPdfCopy(sourcePath, outputPath, operations)
    await PDFDocument.load(await fs.readFile(outputPath))
    return
  }
  if (fileType === 'docx') {
    if (operations.some(operation => !operation.type.startsWith('docx_'))) {
      throw new Error('The edit session contains operations for another document format')
    }
    if (path.extname(sourcePath).toLowerCase() !== '.docx') {
      throw new Error('Legacy .doc files must be converted to .docx before editing')
    }
    await exportDocxCopy(sourcePath, outputPath, operations)
    await JSZip.loadAsync(await fs.readFile(outputPath))
    return
  }
  throw new Error(`Editing ${fileType} documents is not supported`)
}
