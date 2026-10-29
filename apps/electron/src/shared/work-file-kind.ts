/**
 * File-level routing for mixed workspaces: one folder may contain both office
 * documents and source code. The folder is only a root; the target file type
 * decides whether a change goes through the document workbench (`doc_draft`)
 * or the coding flow (`coding_edit` / `coding_apply` / `coding_verify`).
 */

export type WorkFileKind = 'document' | 'code' | 'asset' | 'unknown'

export interface WorkFileKindOptions {
  /**
   * Markdown/plain-text files follow the surface the user opened them in.
   * A document tab keeps them in the document flow; a folder/code view sends
   * them through the coding flow so they still get a reviewable diff.
   */
  documentSurface?: boolean
}

const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx'
])

const SURFACE_SENSITIVE_TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'csv',
  'tsv'
])

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts',
  'js', 'jsx', 'mjs', 'cjs',
  'vue', 'svelte', 'astro',
  'py', 'pyi', 'go', 'java', 'kt', 'kts', 'scala',
  'rs', 'rb', 'php', 'cs', 'fs', 'fsx',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx',
  'm', 'mm', 'swift', 'dart',
  'json', 'jsonc', 'json5',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'plist', 'gradle', 'properties',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'sql', 'graphql', 'gql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'lua', 'r', 'pl', 'ex', 'exs', 'erl', 'hrl',
  'clj', 'cljs', 'groovy', 'sol', 'zig', 'nim', 'v'
])

const ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tiff',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac',
  'mp4', 'mov', 'webm', 'avi', 'mkv',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'db', 'sqlite', 'sqlite3', 'lock'
])

export function getWorkFileExtension (filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, '/').split('/').pop() || ''
  const dot = normalized.lastIndexOf('.')
  if (dot <= 0 || dot === normalized.length - 1) return ''
  return normalized.slice(dot + 1).toLowerCase()
}

export function classifyWorkFile (
  filePath: string,
  options: WorkFileKindOptions = {}
): WorkFileKind {
  const extension = getWorkFileExtension(filePath)
  if (!extension) return 'unknown'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  if (SURFACE_SENSITIVE_TEXT_EXTENSIONS.has(extension)) {
    return options.documentSurface ? 'document' : 'code'
  }
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (ASSET_EXTENSIONS.has(extension)) return 'asset'
  return 'unknown'
}

export function isDocumentFile (filePath: string): boolean {
  return classifyWorkFile(filePath, { documentSurface: true }) === 'document'
}

export function isCodeFile (filePath: string): boolean {
  return classifyWorkFile(filePath) === 'code'
}

export function isAssetFile (filePath: string): boolean {
  return classifyWorkFile(filePath) === 'asset'
}
