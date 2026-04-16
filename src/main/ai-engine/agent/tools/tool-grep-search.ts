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

interface GrepSearchArgs {
  project_id: string
  pattern: string
  dir_path?: string
  include_pattern?: string
  is_regexp?: boolean
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

interface GrepSearchResult {
  pattern: string
  dir_path: string
  matches: GrepMatch[]
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

/**
 * Search a single file line-by-line for pattern matches with context.
 */
async function searchFile (
  filePath: string,
  relativePath: string,
  searchRegex: RegExp,
  contextLines: number,
  matches: GrepMatch[],
  limit: number
): Promise<boolean> {
  // Check file size first
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_SIZE_BYTES) return false
  } catch {
    return false
  }

  const allLines: string[] = []
  let hasMatch = false

  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })

    for await (const line of rl) {
      allLines.push(line)
    }
  } catch {
    return false
  }

  for (let i = 0; i < allLines.length; i++) {
    if (matches.length >= limit) return hasMatch

    if (searchRegex.test(allLines[i])) {
      hasMatch = true
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

  return hasMatch
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
      description: 'Search for text or regex pattern in project source code. Returns matching lines with context. Use this to find function definitions, variable usages, imports, or any text pattern across the project.',
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
          max_results: {
            type: 'integer',
            description: `Maximum number of matching lines to return. Default ${DEFAULT_MAX_RESULTS}, maximum ${ABSOLUTE_MAX_RESULTS}.`
          },
          context_lines: {
            type: 'integer',
            description: `Number of context lines before and after each match. Default ${DEFAULT_CONTEXT_LINES}, maximum ${MAX_CONTEXT_LINES}.`
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
        max_results,
        context_lines
      } = args as unknown as GrepSearchArgs

      const limit = Math.min(Math.max(1, max_results || DEFAULT_MAX_RESULTS), ABSOLUTE_MAX_RESULTS)
      const ctxLines = Math.min(Math.max(0, context_lines ?? DEFAULT_CONTEXT_LINES), MAX_CONTEXT_LINES)
      const searchDir = (dir_path || '').trim()

      onProgress?.('🔍 正在搜索代码...', `pattern: ${pattern}`)

      // Build search regex
      let searchRegex: RegExp
      try {
        searchRegex = is_regexp
          ? new RegExp(pattern, 'i')
          : new RegExp(escapeRegex(pattern), 'i')
      } catch (err) {
        return {
          pattern,
          dir_path: searchDir || '.',
          matches: [],
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
      const matches: GrepMatch[] = []
      let filesMatched = 0

      for (const relativePath of filePaths) {
        if (matches.length >= limit) break

        const fullPath = path.join(baseDir, relativePath)
        const matched = await searchFile(
          fullPath,
          relativePath,
          searchRegex,
          ctxLines,
          matches,
          limit + 1
        )
        if (matched) filesMatched++
      }

      const truncated = matches.length > limit
      const limitedMatches = matches.slice(0, limit)

      onProgress?.('✅ 搜索完成', `${limitedMatches.length} 处匹配 (${filesMatched} 个文件)`)

      return {
        pattern,
        dir_path: searchDir || '.',
        matches: limitedMatches,
        total_matches: truncated ? limit + 1 : matches.length,
        files_searched: filePaths.length,
        files_matched: filesMatched,
        truncated
      }
    }
  }
}
