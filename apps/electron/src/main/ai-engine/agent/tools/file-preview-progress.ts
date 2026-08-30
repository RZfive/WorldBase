import type { ProgressCallback } from '../agent-core.js'

interface FileWriteDelta {
  /** Total lines in the new file content. */
  lineCount: number
  /** Lines present in the new content but not the previous content. */
  added: number
  /** Lines present in the previous content but not the new content. */
  removed: number
}

/**
 * Compute a lightweight line-level delta between two file versions.
 *
 * This is a multiset comparison (order-insensitive), not a full LCS diff — it
 * is O(n+m) and only used to show a "change amount" badge, so an approximate
 * +added / -removed count is sufficient and cheap even for large files. When
 * there is no previous content, every line counts as an addition.
 */
function computeFileWriteDelta (content: string, previousContent?: string): FileWriteDelta {
  const newLines = content === '' ? [] : content.replace(/\r\n/g, '\n').split('\n')
  const lineCount = newLines.length

  if (previousContent === undefined) {
    return { lineCount, added: lineCount, removed: 0 }
  }

  const oldLines = previousContent === '' ? [] : previousContent.replace(/\r\n/g, '\n').split('\n')
  const oldCounts = new Map<string, number>()
  for (const line of oldLines) {
    oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1)
  }

  let added = 0
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0
    if (remaining > 0) {
      oldCounts.set(line, remaining - 1)
    } else {
      added++
    }
  }

  let removed = 0
  for (const remaining of oldCounts.values()) {
    removed += remaining
  }

  return { lineCount, added, removed }
}

/**
 * Report a file write to the UI as a compact, Claude-Code-style status row
 * (file path + change amount) instead of streaming the file body chunk by
 * chunk. This keeps the execution log readable and avoids the rendering cost of
 * streaming large file previews.
 *
 * @param previousContent The file's prior content, when available, so the badge
 *   can show real +added / -removed counts. Omit for newly created files.
 */
export async function streamFilePreview (
  filePath: string,
  content: string,
  onProgress?: ProgressCallback,
  previousContent?: string
): Promise<void> {
  if (!onProgress) {
    return
  }

  const { lineCount, added, removed } = computeFileWriteDelta(content, previousContent)

  onProgress({ type: 'file_preview_start', filePath })
  onProgress({ type: 'file_preview_end', filePath, lineCount, added, removed })
}
