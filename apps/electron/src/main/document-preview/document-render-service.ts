import fs from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import type {
  DocumentFileType,
  DocumentRenderAsset,
  DocumentRenderPreview
} from '../ai-engine/agent/tools/document-types.js'
import { getMainLocale, t } from '../i18n/main-i18n.js'
import {
  ensureDirectory,
  fileExists,
  resolveHtmlPreviewCachePath,
  writeHtmlPreviewCache
} from './preview-cache.js'
import { buildExcelHtmlPreview } from './excel-html-preview.js'
import { buildPptxHtmlPreview } from './pptx-html-preview.js'

function sanitizePreviewHtml (html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<(iframe|object|embed|meta|link|base|form)\b[\s\S]*?(?:<\/\1>|\/?>)/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '')
}

function buildHtmlDocument (title: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${title}</title>`,
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <style>',
    '    :root { color-scheme: light; }',
    '    * { box-sizing: border-box; }',
    '    body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.72; color: #111827; background: #ffffff; }',
    '    img, svg, canvas, table { max-width: 100%; }',
    '    table { border-collapse: collapse; width: 100%; margin: 1em 0; }',
    '    th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; vertical-align: top; }',
    '    th { background: #f3f4f6; }',
    '    p, li { margin: 0.55em 0; }',
    '    h1, h2, h3, h4, h5, h6 { color: #0f172a; line-height: 1.25; margin: 1.1em 0 0.45em; }',
    '  </style>',
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>'
  ].join('\n')
}

async function buildWordHtmlPreview (filePath: string): Promise<string> {
  const outputPath = await resolveHtmlPreviewCachePath(filePath)

  if (await fileExists(outputPath)) {
    return outputPath
  }

  await ensureDirectory(path.dirname(outputPath))

  const htmlResult = await mammoth.convertToHtml({ path: filePath })
  const htmlBody = sanitizePreviewHtml(htmlResult.value || '') || t('mainDialog.emptyDocumentPreviewText')
  await fs.writeFile(outputPath, buildHtmlDocument(path.basename(filePath), htmlBody), 'utf8')
  return outputPath
}

export async function buildDocumentRenderPreview (filePath: string, fileType: DocumentFileType): Promise<DocumentRenderPreview> {
  const generatedAt = new Date().toISOString()

  if (fileType === 'pdf') {
    return {
      kind: 'pdf',
      source: 'original',
      status: 'ready',
      mimeType: 'application/pdf',
      assetPath: filePath,
      generatedAt
    }
  }

  if (fileType === 'md') {
    // The renderer replays the original Markdown through the chat pipeline
    // (renderMarkdown + mermaid + global .markdown-body styles), so the file
    // itself is the preview asset — restore needs no generated cache.
    return {
      kind: 'markdown',
      source: 'original',
      status: 'ready',
      mimeType: 'text/markdown; charset=utf-8',
      assetPath: filePath,
      generatedAt
    }
  }

  if (fileType === 'docx') {
    try {
      const assetPath = await buildWordHtmlPreview(filePath)
      return {
        kind: 'html',
        source: 'generated',
        status: 'ready',
        mimeType: 'text/html; charset=utf-8',
        assetPath,
        generatedAt
      }
    } catch (error) {
      return {
        kind: 'structured',
        source: 'fallback',
        status: 'unavailable',
        error: t('mainDialog.wordPreviewFallbackError', { message: (error as Error).message || String(error) }),
        generatedAt
      }
    }
  }

  if (fileType === 'xlsx') {
    try {
      const assetPath = await buildExcelHtmlPreview(filePath)
      return {
        kind: 'html',
        source: 'generated',
        status: 'ready',
        mimeType: 'text/html; charset=utf-8',
        assetPath,
        generatedAt
      }
    } catch (error) {
      return {
        kind: 'structured',
        source: 'fallback',
        status: 'unavailable',
        error: t('mainDialog.excelPreviewFallbackError', { message: (error as Error).message || String(error) }),
        generatedAt
      }
    }
  }

  if (fileType === 'pptx') {
    try {
      const assetPath = await buildPptxHtmlPreview(filePath)
      return {
        kind: 'html',
        source: 'generated',
        status: 'ready',
        mimeType: 'text/html; charset=utf-8',
        assetPath,
        generatedAt
      }
    } catch (error) {
      return {
        kind: 'structured',
        source: 'fallback',
        status: 'unavailable',
        error: t('mainDialog.pptxPreviewFallbackError', { message: (error as Error).message || String(error) }),
        generatedAt
      }
    }
  }

  return {
    kind: 'structured',
    source: 'fallback',
    status: 'unavailable',
    error: t('mainDialog.unsupportedRealPreviewFormat', { fileType }),
    generatedAt
  }
}

export async function readDocumentRenderAsset (render: DocumentRenderPreview | undefined): Promise<DocumentRenderAsset | null> {
  if (!render || render.status !== 'ready' || render.kind === 'structured' || !render.mimeType || !render.assetPath) {
    return null
  }

  const bytes = await fs.readFile(render.assetPath)
  return {
    mimeType: render.mimeType,
    bytes: new Uint8Array(bytes)
  }
}
