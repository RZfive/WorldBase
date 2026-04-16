import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { app } from 'electron'

/**
 * Thresholds for tool result handling.
 *
 * - Below INLINE_THRESHOLD: returned as-is to the LLM message.
 * - Between INLINE_THRESHOLD and PERSIST_THRESHOLD: truncated with metadata.
 * - Above PERSIST_THRESHOLD: persisted to a temporary file, summary returned.
 */
const INLINE_THRESHOLD = 30_000 // 30 KB
const PERSIST_THRESHOLD = 100_000 // 100 KB

/**
 * ProcessedResult returned by the storage after processing a tool result.
 */
export interface ProcessedResult {
  /** The content string to include in the LLM message history. */
  content: string
  /** If the result was persisted to disk, this is the file path. */
  persistedPath?: string
  /** The original character count before processing. */
  originalLength: number
  /** Whether the result was truncated or persisted. */
  strategy: 'inline' | 'truncated' | 'persisted'
}

/**
 * ToolResultStorage — 大输出文件化处理
 *
 * Processes tool results based on size:
 * - Small results (< 30KB): returned inline
 * - Medium results (30KB–100KB): truncated with head/tail preview
 * - Large results (> 100KB): written to a temp file, returns path + summary
 *
 * Inspired by Claude Code's toolResultStorage pattern where large outputs
 * are persisted to avoid blowing up the context window.
 */
export class ToolResultStorage {
  private storageDir: string

  constructor (storageDir?: string) {
    this.storageDir = storageDir || this._defaultStorageDir()
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true })
    }
  }

  /**
   * Process a tool result and decide how to handle it.
   */
  async process (
    result: unknown,
    toolName: string,
    callId: string
  ): Promise<ProcessedResult> {
    const serialized = this._serialize(result)

    if (serialized.length <= INLINE_THRESHOLD) {
      return {
        content: serialized,
        originalLength: serialized.length,
        strategy: 'inline'
      }
    }

    if (serialized.length > PERSIST_THRESHOLD) {
      return this._persistResult(serialized, toolName, callId)
    }

    return this._truncateResult(serialized, toolName)
  }

  /**
   * Serialize a tool result to a string.
   */
  private _serialize (result: unknown): string {
    if (typeof result === 'string') return result
    try {
      return JSON.stringify(result, null, 2)
    } catch {
      return String(result)
    }
  }

  /**
   * Truncate a medium-sized result with head and tail preview.
   */
  private _truncateResult (serialized: string, toolName: string): ProcessedResult {
    const headSize = Math.floor(INLINE_THRESHOLD * 0.6)
    const tailSize = Math.floor(INLINE_THRESHOLD * 0.3)
    const head = serialized.slice(0, headSize)
    const tail = serialized.slice(-tailSize)
    const omitted = serialized.length - headSize - tailSize

    const content =
      `${head}\n\n` +
      `...[TRUNCATED: ${omitted} characters omitted from ${toolName} result (total: ${serialized.length} chars)]...\n\n` +
      `${tail}`

    return {
      content,
      originalLength: serialized.length,
      strategy: 'truncated'
    }
  }

  /**
   * Persist a large result to a temporary file and return a summary.
   */
  private async _persistResult (
    serialized: string,
    toolName: string,
    callId: string
  ): Promise<ProcessedResult> {
    const filename = `${toolName}_${callId}_${Date.now()}.txt`
    const filePath = path.join(this.storageDir, filename)

    await fs.writeFile(filePath, serialized, 'utf-8')

    // Build a summary with head preview
    const previewSize = 500
    const preview = serialized.slice(0, previewSize)
    const lineCount = (serialized.match(/\n/g) || []).length + 1

    const content =
      `[Tool result persisted to file]\n` +
      `Path: ${filePath}\n` +
      `Size: ${serialized.length} characters, ~${lineCount} lines\n` +
      `Tool: ${toolName}\n\n` +
      `Preview (first ${previewSize} chars):\n${preview}${serialized.length > previewSize ? '...' : ''}`

    return {
      content,
      persistedPath: filePath,
      originalLength: serialized.length,
      strategy: 'persisted'
    }
  }

  /**
   * Clean up old persisted result files (older than maxAgeMs).
   */
  async cleanup (maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now()
    let removed = 0

    try {
      const entries = await fs.readdir(this.storageDir)
      for (const entry of entries) {
        const filePath = path.join(this.storageDir, entry)
        try {
          const stat = await fs.stat(filePath)
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.unlink(filePath)
            removed++
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    return removed
  }

  private _defaultStorageDir (): string {
    try {
      return path.join(app.getPath('temp'), 'the-world', 'tool-results')
    } catch {
      // Fallback if app is not ready (e.g. during tests)
      return path.join(process.env.TMPDIR || '/tmp', 'the-world', 'tool-results')
    }
  }
}
