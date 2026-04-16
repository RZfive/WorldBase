import path from 'node:path'
import fs from 'node:fs/promises'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface GlobSearchArgs {
  project_id: string
  pattern: string
  dir_path?: string
  max_results?: number
}

interface GlobMatch {
  path: string
  size: number
  type: 'file' | 'directory'
}

interface GlobSearchResult {
  pattern: string
  dir_path: string
  matches: GlobMatch[]
  total_matches: number
  truncated: boolean
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const DEFAULT_MAX_RESULTS = 100
const ABSOLUTE_MAX_RESULTS = 500

/** Directories to always skip when walking the tree. */
const IGNORED_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', '.cache',
  '.turbo', 'coverage', '.output', '__pycache__', '.venv'
])

/**
 * Convert a simple glob pattern to a RegExp.
 *
 * Supports:
 *   *      → any chars except /
 *   **     → any chars including /  (directory traversal)
 *   ?      → single char
 *   {a,b}  → alternation
 *   [abc]  → character class
 */
function globToRegex (pattern: string): RegExp {
  let reStr = ''
  let i = 0
  const n = pattern.length

  while (i < n) {
    const ch = pattern[i]

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // **  or  **/  — match any path segment(s)
        reStr += '.*'
        i += 2
        // Skip optional trailing /
        if (pattern[i] === '/') i++
      } else {
        reStr += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      reStr += '[^/]'
      i++
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i)
      if (close === -1) {
        reStr += '\\{'
        i++
      } else {
        const group = pattern.slice(i + 1, close).split(',').map(escapeRegexPart).join('|')
        reStr += `(?:${group})`
        i = close + 1
      }
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i)
      if (close === -1) {
        reStr += '\\['
        i++
      } else {
        reStr += pattern.slice(i, close + 1)
        i = close + 1
      }
    } else {
      reStr += escapeRegexChar(ch)
      i++
    }
  }

  return new RegExp(`^${reStr}$`, 'i')
}

function escapeRegexChar (ch: string): string {
  return /[.+^${}()|\\]/.test(ch) ? `\\${ch}` : ch
}

function escapeRegexPart (part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Recursively walk a directory and collect files matching a glob pattern.
 */
async function walkGlob (
  baseDir: string,
  regex: RegExp,
  currentRelative: string,
  results: GlobMatch[],
  limit: number
): Promise<void> {
  if (results.length >= limit) return

  const fullDir = path.join(baseDir, currentRelative)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(fullDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= limit) return

    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
      continue
    }

    const entryRelative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      // Test directory name with trailing /
      if (regex.test(entryRelative) || regex.test(`${entryRelative}/`)) {
        results.push({ path: entryRelative, size: 0, type: 'directory' })
      }
      await walkGlob(baseDir, regex, entryRelative, results, limit)
    } else {
      if (regex.test(entryRelative)) {
        let size = 0
        try {
          const stat = await fs.stat(path.join(fullDir, entry.name))
          size = stat.size
        } catch { /* ignore */ }
        results.push({ path: entryRelative, size, type: 'file' })
      }
    }
  }
}

/**
 * Tool: glob_search — 按 glob 模式搜索项目文件
 */
export function toolGlobSearch (services: ToolServices): Tool {
  return {
    definition: {
      name: 'glob_search',
      description: 'Search for files in a project using glob patterns (e.g. "**/*.ts", "src/**/index.*", "*.{js,ts}"). Returns matching file paths with sizes. Use this to quickly locate files by name or extension pattern.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          pattern: {
            type: 'string',
            description: 'Glob pattern to match file paths. Supports: * (any chars), ** (any path), ? (single char), {a,b} (alternation), [abc] (char class).'
          },
          dir_path: {
            type: 'string',
            description: 'Directory to search within (relative to project root). Defaults to project root.'
          },
          max_results: {
            type: 'integer',
            description: `Maximum number of results. Default ${DEFAULT_MAX_RESULTS}, maximum ${ABSOLUTE_MAX_RESULTS}.`
          }
        },
        required: ['project_id', 'pattern']
      }
    },
    handler: async (args, onProgress): Promise<GlobSearchResult> => {
      const { project_id, pattern, dir_path, max_results } = args as unknown as GlobSearchArgs
      const limit = Math.min(Math.max(1, max_results || DEFAULT_MAX_RESULTS), ABSOLUTE_MAX_RESULTS)
      const searchDir = (dir_path || '').trim()

      onProgress?.('🔍 正在搜索文件...', `pattern: ${pattern}`)

      const baseDir = services.projectFS._resolveProjectPath(project_id, searchDir)
      const regex = globToRegex(pattern)
      const matches: GlobMatch[] = []

      await walkGlob(baseDir, regex, '', matches, limit + 1)

      const truncated = matches.length > limit
      const limitedMatches = matches.slice(0, limit)

      onProgress?.('✅ 搜索完成', `${limitedMatches.length} 个匹配`)

      return {
        pattern,
        dir_path: searchDir || '.',
        matches: limitedMatches,
        total_matches: truncated ? limit + 1 : matches.length,
        truncated
      }
    }
  }
}
