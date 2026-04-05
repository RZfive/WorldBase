import type { ProgressCallback } from '../agent-core.js'

const MAX_PREVIEW_LINES = 240
const MAX_PREVIEW_CHUNKS = 40
const STREAM_DELAY_MS = 12

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildChunks (content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const previewLines = lines.slice(0, MAX_PREVIEW_LINES)

  if (previewLines.length <= 1 && normalized.length > 320) {
    const chunks: string[] = []
    for (let index = 0; index < normalized.length; index += 320) {
      chunks.push(normalized.slice(index, index + 320))
    }
    return chunks.slice(0, MAX_PREVIEW_CHUNKS)
  }

  const linesPerChunk = Math.max(1, Math.ceil(previewLines.length / MAX_PREVIEW_CHUNKS))
  const chunks: string[] = []

  for (let index = 0; index < previewLines.length; index += linesPerChunk) {
    const chunk = previewLines.slice(index, index + linesPerChunk).join('\n')
    chunks.push(index + linesPerChunk < previewLines.length ? `${chunk}\n` : chunk)
  }

  return chunks
}

export async function streamFilePreview (filePath: string, content: string, onProgress?: ProgressCallback): Promise<void> {
  if (!onProgress) {
    return
  }

  const normalized = content.replace(/\r\n/g, '\n')
  const lineCount = normalized.split('\n').length
  const truncated = lineCount > MAX_PREVIEW_LINES
  const chunks = buildChunks(normalized)

  onProgress({ type: 'file_preview_start', filePath, truncated })

  for (const chunk of chunks) {
    onProgress({ type: 'file_preview_chunk', filePath, content: chunk })
    await sleep(STREAM_DELAY_MS)
  }

  onProgress({ type: 'file_preview_end', filePath, truncated })
}