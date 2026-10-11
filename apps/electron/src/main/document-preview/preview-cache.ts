/**
 * Shared helpers for generated HTML document previews: on-disk cache keyed by
 * source path/size/mtime (same scheme as the Word mammoth preview) plus the
 * self-contained document wrapper. Preview HTML must embed its styles inside
 * <body> because the renderer extracts body.innerHTML when injecting it.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getMainLocale } from '../i18n/main-i18n.js'

const RENDER_CACHE_DIRNAME = 'document-render-cache'

export function getRenderCacheRoot (): string {
  return path.join(app.getPath('userData'), RENDER_CACHE_DIRNAME)
}

export function buildCacheKey (filePath: string, size: number, mtimeMs: number): string {
  return createHash('sha1')
    .update(filePath)
    .update(':')
    .update(String(size))
    .update(':')
    .update(String(Math.floor(mtimeMs)))
    .digest('hex')
}

export async function ensureDirectory (dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}

export async function fileExists (filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Locale-scoped cache path for a generated HTML preview of `filePath`. */
export async function resolveHtmlPreviewCachePath (filePath: string): Promise<string> {
  const stat = await fs.stat(filePath)
  const cacheKey = buildCacheKey(filePath, stat.size, stat.mtimeMs)
  return path.join(getRenderCacheRoot(), cacheKey, `${path.parse(filePath).name}.${getMainLocale()}.preview.html`)
}

export async function writeHtmlPreviewCache (outputPath: string, html: string): Promise<void> {
  await ensureDirectory(path.dirname(outputPath))
  await fs.writeFile(outputPath, html, 'utf8')
}

export function escapeHtml (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Wraps preview content into a standalone HTML document. Styles live inside
 * <body> so they survive the renderer's body-innerHTML extraction.
 */
export function wrapHtmlPreviewDocument (title: string, bodyHtml: string, styleCss: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${escapeHtml(title)}</title>`,
    '</head>',
    '<body>',
    `<style>${styleCss}</style>`,
    bodyHtml,
    '</body>',
    '</html>'
  ].join('\n')
}
