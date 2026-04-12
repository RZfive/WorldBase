/**
 * Document parser service — converts Office / PDF files into structured DocumentArtifact.
 * Delegates to format-specific parsers that produce DocumentNode trees.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { DocumentArtifact, DocumentFileType, DocumentNode } from './document-types.js'
import { parseExcelToNodes } from './document-parser-excel.js'
import { parseWordToNodes } from './document-parser-word.js'
import { parsePptxToNodes } from './document-parser-pptx.js'
import { parsePdfToNodes } from './document-parser-pdf.js'

const EXTENSION_TYPE_MAP: Record<string, DocumentFileType> = {
  '.pdf': 'pdf',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.docx': 'docx',
  '.doc': 'docx',
  '.pptx': 'pptx',
  '.ppt': 'pptx'
}

export function detectDocumentType (filePath: string): DocumentFileType {
  const ext = path.extname(filePath).toLowerCase()
  return EXTENSION_TYPE_MAP[ext] || 'unknown'
}

export function isSupportedDocument (filePath: string): boolean {
  return detectDocumentType(filePath) !== 'unknown'
}

function generateId (): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function flattenNodeText (nodes: DocumentNode[]): string {
  const parts: string[] = []
  for (const node of nodes) {
    if (node.text) parts.push(node.text)
    if (node.children) {
      parts.push(flattenNodeText(node.children))
    }
  }
  return parts.join('\n')
}

/**
 * Parse any supported document file into a structured DocumentArtifact.
 */
export async function parseDocument (filePath: string): Promise<DocumentArtifact> {
  const resolvedPath = path.resolve(filePath)
  const stat = await fs.stat(resolvedPath)
  if (!stat.isFile()) throw new Error(`路径不是一个文件: ${resolvedPath}`)

  const fileType = detectDocumentType(resolvedPath)
  if (fileType === 'unknown') throw new Error(`不支持的文件格式: ${path.extname(resolvedPath)}`)

  const buffer = await fs.readFile(resolvedPath)
  let nodes: DocumentNode[]

  switch (fileType) {
    case 'xlsx':
      nodes = await parseExcelToNodes(resolvedPath)
      break
    case 'docx':
      nodes = await parseWordToNodes(buffer)
      break
    case 'pptx':
      nodes = await parsePptxToNodes(buffer)
      break
    case 'pdf':
      nodes = await parsePdfToNodes(buffer)
      break
    default:
      throw new Error(`未实现的解析器: ${fileType}`)
  }

  const plainText = flattenNodeText(nodes)

  return {
    id: generateId(),
    filePath: resolvedPath,
    fileName: path.basename(resolvedPath),
    fileSize: stat.size,
    fileType,
    plainText,
    nodes,
    importedAt: new Date().toISOString()
  }
}
