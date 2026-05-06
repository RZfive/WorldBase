/**
 * PDF → DocumentNode[] parser.
 * Uses pdf-parse v2 (PDFParse class) to extract text per page.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { DocumentNode } from './document-types.js'

interface PdfWorkerModule {
  getData: () => string
}

let nodeCounter = 0
let pdfWorkerConfigured = false
let pdfWorkerModulePromise: Promise<PdfWorkerModule> | null = null
const moduleRequire = createRequire(import.meta.url)

function nextId (): string {
  return `pdf_${++nodeCounter}`
}

function isPdfWorkerModule (value: unknown): value is PdfWorkerModule {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { getData?: unknown }).getData === 'function'
}

async function loadPdfWorkerModule (): Promise<PdfWorkerModule> {
  if (!pdfWorkerModulePromise) {
    const workerModuleUrl = pathToFileURL(moduleRequire.resolve('pdf-parse/worker')).href
    pdfWorkerModulePromise = import(workerModuleUrl).then((module) => {
      if (!isPdfWorkerModule(module)) {
        throw new Error('pdf-parse worker 模块缺少 getData 导出')
      }
      return module
    })
  }

  return pdfWorkerModulePromise
}

export async function parsePdfToNodes (buffer: Buffer): Promise<DocumentNode[]> {
  nodeCounter = 0
  const { PDFParse } = await import('pdf-parse')

  if (!pdfWorkerConfigured) {
    const { getData } = await loadPdfWorkerModule()
    PDFParse.setWorker(getData())
    pdfWorkerConfigured = true
  }

  const parser = new PDFParse({ data: buffer })
  try {
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

    return nodes
  } finally {
    await parser.destroy()
  }
}
