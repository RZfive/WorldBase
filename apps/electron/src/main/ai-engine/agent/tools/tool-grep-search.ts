import path from 'node:path'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  projectFS: ProjectFS
}

type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

interface GrepSearchArgs {
  project_id: string
  pattern: string
  dir_path?: string
  include_pattern?: string
  is_regexp?: boolean
  case_sensitive?: boolean
  output_mode?: GrepOutputMode
  max_results?: number
  context_lines?: number
}

interface GrepMatch {
  file: string
  line: number
  content: string
  context_before: string[]
  context_after: string[]
}

interface GrepFileCount {
  file: string
  count: number
}

interface GrepSearchResult {
  pattern: string
  dir_path: string
  output_mode: GrepOutputMode
  case_sensitive: boolean
  /** Matching lines with context (output_mode = 'content'). */
  matches?: GrepMatch[]
  /** Files that contain at least one match (output_mode = 'files_with_matches'). */
  files?: string[]
  /** Per-file match counts (output_mode = 'count'). */
  counts?: GrepFileCount[]
  total_matches: number
  files_searched: number
  files_matched: number
  truncated: boolean
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const DEFAULT_MAX_RESULTS = 50
const ABSOLUTE_MAX_RESULTS = 200
const DEFAULT_CONTEXT_LINES = 2
const MAX_CONTEXT_LINES = 5

/** Maximum file size to search (skip very large files). */
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 // 2 MB

/** Directories to always skip. */
const IGNORED_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', '.cache',
  '.turbo', 'coverage', '.output', '__pycache__', '.venv'
])

/** Binary-looking file extensions to skip. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.sqlite', '.db', '.lock'
])

/**
 * Convert a simple include pattern (e.g. "*.ts") to a regex for matching file names.
 */
function includePatternToRegex (pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * Recursively collect all file paths within a directory.
 */
async function collectFiles (
  baseDir: string,
  currentRelative: string,
  includeRegex: RegExp | null,
  result: string[]
): Promise<void> {
  const fullDir = path.join(baseDir, currentRelative)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(fullDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await collectFiles(baseDir, currentRelative ? `${currentRelative}/${entry.name}` : entry.name, includeRegex, result)
    } else {
      const ext = path.extname(entry.name).toLowerCase()
      if (BINARY_EXTENSIONS.has(ext)) continue

      const relativePath = currentRelative ? `${currentRelative}/${entry.name}` : entry.name

      if (includeRegex && !includeRegex.test(entry.name)) continue

      result.push(relativePath)
    }
  }
}

interface FileScanResult {
  /** Whether the file contains at least one match. */
  matched: boolean
  /** Total matching lines in the file. */
  count: number
  /** Matching lines with context (only collected in 'content' mode). */
  matches: GrepMatch[]
}

/**
 * Scan a single file line-by-line for pattern matches.
 *
 * In 'files_with_matches' mode it short-circuits on the first match. In
 * 'content' mode it collects matches with context up to contentMatchLimit. In
 * 'count' mode it counts every matching line. Returns null when the file is
 * skipped (too large or unreadable).
 */
async function scanFile (
  filePath: string,
  relativePath: string,
  searchRegex: RegExp,
  mode: GrepOutputMode,
  contextLines: number,
  contentMatchLimit: number
): Promise<FileScanResult | null> {
  // Check file size first
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_SIZE_BYTES) return null
  } catch {
    return null
  }

  const allLines: string[] = []

  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })

    for await (const line of rl) {
      allLines.push(line)
    }
  } catch {
    return null
  }

  let count = 0
  const matches: GrepMatch[] = []

  for (let i = 0; i < allLines.length; i++) {
    if (!searchRegex.test(allLines[i])) continue

    count++

    if (mode === 'files_with_matches') {
      // One match is enough to flag the file.
      return { matched: true, count: 1, matches: [] }
    }

    if (mode === 'content' && matches.length < contentMatchLimit) {
      const beforeStart = Math.max(0, i - contextLines)
      const afterEnd = Math.min(allLines.length - 1, i + contextLines)
      matches.push({
        file: relativePath,
        line: i + 1,
        content: allLines[i],
        context_before: allLines.slice(beforeStart, i),
        context_after: allLines.slice(i + 1, afterEnd + 1)
      })
    }
  }

  return { matched: count > 0, count, matches }
}

/**
 * Escape a string for use in a RegExp.
 */
function escapeRegex (str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Tool: grep_search — 在项目代码中搜索文本或正则模式
 */
export function toolGrepSearch (services: ToolServices): Tool {
  return {
    definition: {
      name: 'grep_search',
      description: 'Search for text or a regex pattern in project source code. Use this to find function definitions, variable usages, imports, or any text pattern across the project. Search is case-insensitive by default (set case_sensitive: true to change). output_mode selects the result shape: "content" (default) returns matching lines with context, "files_with_matches" returns only the list of files that match (cheapest — good for a first pass before reading), and "count" returns per-file match counts.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          pattern: {
            type: 'string',
            description: 'Search text or regex pattern'
          },
          dir_path: {
            type: 'string',
            description: 'Directory to search within (relative to project root). Defaults to project root.'
          },
          include_pattern: {
            type: 'string',
            description: 'Only search files matching this pattern (e.g. "*.ts", "*.{js,jsx}").'
          },
          is_regexp: {
            type: 'boolean',
            description: 'Whether the pattern is a regular expression. Default: false (plain text search).'
          },
          case_sensitive: {
            type: 'boolean',
            description: 'Whether the search is case-sensitive. Default: false (case-insensitive).'
          },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'Result shape. "content" (default) = matching lines with context; "files_with_matches" = list of matching files only; "count" = per-file match counts.'
          },
          max_results: {
            type: 'integer',
            description: `Maximum items to return. In "content" mode this caps matching lines; in "files_with_matches"/"count" it caps files. Default ${DEFAULT_MAX_RESULTS}, maximum ${ABSOLUTE_MAX_RESULTS}.`
          },
          context_lines: {
            type: 'integer',
            description: `Number of context lines before and after each match (content mode only). Default ${DEFAULT_CONTEXT_LINES}, maximum ${MAX_CONTEXT_LINES}.`
          }
        },
        required: ['project_id', 'pattern']
      }
    },
    handler: async (args, onProgress): Promise<GrepSearchResult> => {
      const {
        project_id,
        pattern,
        dir_path,
        include_pattern,
        is_regexp,
        case_sensitive,
        output_mode,
        max_results,
        context_lines
      } = args as unknown as GrepSearchArgs

      const mode: GrepOutputMode =
        output_mode === 'files_with_matches' || output_mode === 'count' ? output_mode : 'content'
      const caseSensitive = case_sensitive === true
      const limit = Math.min(Math.max(1, max_results || DEFAULT_MAX_RESULTS), ABSOLUTE_MAX_RESULTS)
      const ctxLines = Math.min(Math.max(0, context_lines ?? DEFAULT_CONTEXT_LINES), MAX_CONTEXT_LINES)
      const searchDir = (dir_path || '').trim()
      const flags = caseSensitive ? '' : 'i'

      onProgress?.('🔍 正在搜索代码...', `pattern: ${pattern}`)

      // Build search regex
      let searchRegex: RegExp
      try {
        searchRegex = is_regexp
          ? new RegExp(pattern, flags)
          : new RegExp(escapeRegex(pattern), flags)
      } catch (err) {
        return {
          pattern,
          dir_path: searchDir || '.',
          output_mode: mode,
          case_sensitive: caseSensitive,
          matches: mode === 'content' ? [] : undefined,
          files: mode === 'files_with_matches' ? [] : undefined,
          counts: mode === 'count' ? [] : undefined,
          total_matches: 0,
          files_searched: 0,
          files_matched: 0,
          truncated: false
        }
      }

      // Build include filter
      const includeRegex = include_pattern ? includePatternToRegex(include_pattern) : null

      // Collect all candidate files
      const baseDir = services.projectFS._resolveProjectPath(project_id, searchDir)
      const filePaths: string[] = []
      await collectFiles(baseDir, '', includeRegex, filePaths)

      onProgress?.('🔍 搜索中...', `${filePaths.length} 个文件`)

      // Search files
      const contentMatches: GrepMatch[] = []
      const matchedFiles: string[] = []
      const fileCounts: GrepFileCount[] = []
      let filesMatched = 0
      let totalMatches = 0
      let stoppedEarly = false

      for (const relativePath of filePaths) {
        // Stop once the cap for the active mode is reached (lines for content,
        // files for the file-oriented modes).
        const reachedCap = mode === 'content'
          ? contentMatches.length >= limit
          : filesMatched >= limit
        if (reachedCap) {
          stoppedEarly = true
          break
        }

        const fullPath = path.join(baseDir, relativePath)
        const result = await scanFile(
          fullPath,
          relativePath,
          searchRegex,
          mode,
          ctxLines,
          limit - contentMatches.length
        )
        if (!result || !result.matched) continue

        filesMatched++
        totalMatches += result.count

        if (mode === 'content') {
          for (const m of result.matches) {
            if (contentMatches.length >= limit) break
            contentMatches.push(m)
          }
        } else if (mode === 'files_with_matches') {
          matchedFiles.push(relativePath)
        } else {
          fileCounts.push({ file: relativePath, count: result.count })
        }
      }

      const truncated = stoppedEarly || (mode === 'content' && totalMatches > contentMatches.length)

      onProgress?.('✅ 搜索完成', `${filesMatched} 个文件命中`)

      return {
        pattern,
        dir_path: searchDir || '.',
        output_mode: mode,
        case_sensitive: caseSensitive,
        matches: mode === 'content' ? contentMatches : undefined,
        files: mode === 'files_with_matches' ? matchedFiles : undefined,
        counts: mode === 'count' ? fileCounts : undefined,
        total_matches: totalMatches,
        files_searched: filePaths.length,
        files_matched: filesMatched,
        truncated
      }
    }
  }
}
