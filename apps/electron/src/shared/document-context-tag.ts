/**
 * `[[docfile:<artifactId>|<label>]]` — whole-document context reference.
 *
 * The tag is inserted from the document workspace ("引用到对话") and resolved
 * on send: the renderer strips it from the visible text while the main
 * process replaces it with the document's full plain text so the model can
 * rewrite the document (via `doc_draft`) without a separate read round trip.
 * Shared between the renderer (tag extraction) and main (prompt building).
 */

export const DOCFILE_TAG_PATTERN = /\[\[docfile:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g

/** Prompt ceiling per referenced document, in characters. */
export const MAX_DOCFILE_CONTEXT_CHARS = 24000

export function buildDocfileTag (artifactId: string, label?: string): string {
  const cleaned = (label || '').trim()
  return cleaned ? `[[docfile:${artifactId}|${cleaned}]]` : `[[docfile:${artifactId}]]`
}

export function extractDocfileTagRefs (text: string, pattern: RegExp = DOCFILE_TAG_PATTERN): { artifactIds: string[]; normalizedText: string } {
  const artifactIds = new Set<string>()
  const normalizedText = text
    .replace(pattern, (_match, artifactId: string, rawLabel?: string) => {
      artifactIds.add(artifactId)
      const label = rawLabel?.trim()
      return label ? `文档引用「${label}」` : '文档引用'
    })
    .replace(/\n{3,}/g, '\n\n')

  return { artifactIds: Array.from(artifactIds), normalizedText }
}

export interface DocfileContextEntry {
  fileName: string
  fileType?: string
  plainText: string
}

export function buildDocfileContextPrompt (entries: DocfileContextEntry[]): string {
  return entries.map(entry => {
    const typeSuffix = entry.fileType ? ` · ${entry.fileType.toUpperCase()}` : ''
    const text = entry.plainText.trim()
    const bounded = text.length > MAX_DOCFILE_CONTEXT_CHARS
      ? `${text.slice(0, MAX_DOCFILE_CONTEXT_CHARS)}\n…[内容过长，已截断 ${text.length - MAX_DOCFILE_CONTEXT_CHARS} 字符]`
      : text
    return `【文档全文：${entry.fileName}${typeSuffix}】\n${bounded || '（空文档）'}\n【文档结束】`
  }).join('\n\n')
}
