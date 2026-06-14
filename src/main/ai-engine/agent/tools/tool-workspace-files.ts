import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { ReadFileTracker } from './read-tracker.js'
import { streamFilePreview } from './file-preview-progress.js'
import { PROJECT_COMMAND_WHITELIST, DANGEROUS_COMMAND_PATTERNS, isDeveloperCommandModeEnabled } from './command-capabilities.js'
import { createBundledRuntimeEnv } from '../../../project-runtime/bundled-runtime.js'
import {
  deleteFolderWorkspaceFile,
  listFolderWorkspaceFiles,
  normalizeWorkspaceRelativePath,
  readFolderWorkspaceFile,
  resolveFolderWorkspacePath,
  writeFolderWorkspaceFile
} from '../../../folder-workspace/folder-workspace-fs.js'

interface ToolServices {
  workspaceRoot: string
}

interface WorkspaceFileArgs {
  file_path: string
}

interface ReadWorkspaceFileArgs extends WorkspaceFileArgs {
  start_line?: number
  max_lines?: number
}

interface WriteWorkspaceFileArgs extends WorkspaceFileArgs {
  content: string
}

interface EditWorkspaceFileArgs extends WorkspaceFileArgs {
  old_string: string
  new_string: string
  replace_all?: boolean
}

interface PatchWorkspaceFileArgs extends WorkspaceFileArgs {
  patches: unknown
}

interface DeleteWorkspaceFileArgs extends WorkspaceFileArgs {}

interface ListWorkspaceFilesArgs {
  dir_path?: string
}

type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

interface GrepWorkspaceArgs {
  pattern: string
  dir_path?: string
  include_pattern?: string
  is_regexp?: boolean
  case_sensitive?: boolean
  output_mode?: GrepOutputMode
  max_results?: number
  context_lines?: number
}

interface GlobWorkspaceArgs {
  pattern: string
  dir_path?: string
  max_results?: number
}

interface PatchEntry {
  start_line: number
  end_line: number
  content: string
}

interface RunWorkspaceCommandArgs {
  command: string
  cwd?: string
  timeout_seconds?: number
}

interface GetWorkspaceCommandStatusArgs {
  command_id: string
}

interface ParsedCommand {
  baseCommand: string
  tokens: string[]
}

type CommandReason = 'completed' | 'spawn_error' | 'timeout' | 'output_limit'
type CommandStatus = 'running' | 'completed' | 'failed'

interface WorkspaceCommandSnapshot {
  command_id: string
  workspace_root: string
  command: string
  cwd: string
  pid?: number
  status: CommandStatus
  reason?: CommandReason
  created_at: string
  started_at: string
  completed_at?: string
  exitCode?: number | null
  signal?: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputTruncated: boolean
  background: boolean
  message?: string
  error?: string
}

interface WorkspaceCommandExecutionRecord extends WorkspaceCommandSnapshot {
  child: ChildProcess
}

interface GrepMatch {
  file: string
  line: number
  content: string
  context_before: string[]
  context_after: string[]
}

interface GlobMatch {
  path: string
  size: number
  type: 'file' | 'directory'
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const MAX_RETURN_CHARS = 50000
const EDGE_RETURN_CHARS = 25000
const DEFAULT_SEGMENT_LINES = 1000
const MAX_SEGMENT_LINES = 2000
const LINE_NUMBER_WIDTH = 6
const DEFAULT_GREP_MAX_RESULTS = 50
const MAX_GREP_RESULTS = 200
const DEFAULT_GLOB_MAX_RESULTS = 100
const MAX_GLOB_RESULTS = 500
const DEFAULT_CONTEXT_LINES = 2
const MAX_CONTEXT_LINES = 5
const MAX_SEARCH_FILE_SIZE_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 90
const MAX_TIMEOUT_SECONDS = 180
const HEARTBEAT_INTERVAL_MS = 10000
const MAX_STDOUT_CHARS = 20000
const MAX_STDERR_CHARS = 10000
const MAX_COMMAND_HISTORY = 100
const LONG_RUNNING_NPM_SCRIPTS = new Set(['dev', 'start', 'serve', 'preview', 'watch'])
const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'branch'])
const IGNORED_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', '.cache',
  '.turbo', 'coverage', '.output', '__pycache__', '.venv'
])
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.sqlite', '.db', '.lock'
])

const commandHistory = new Map<string, WorkspaceCommandExecutionRecord>()
let commandSequence = 0

function workspaceTrackerId (root: string): string {
  return `workspace:${path.resolve(root)}`
}

function renderWithLineNumbers (lines: string[], firstLineNumber: number): string {
  return lines
    .map((line, i) => `${String(firstLineNumber + i).padStart(LINE_NUMBER_WIDTH)}\t${line}`)
    .join('\n')
}

async function readWorkspaceTextFileFull (root: string, filePath: string): Promise<string> {
  const normalized = normalizeWorkspaceRelativePath(filePath)
  if (!normalized) throw new Error('file_path is required')
  const fullPath = resolveFolderWorkspacePath(root, normalized)
  const stat = await fs.stat(fullPath)
  if (!stat.isFile()) throw new Error(`Path is not a file: ${normalized}`)
  return fs.readFile(fullPath, 'utf-8')
}

function countOccurrences (haystack: string, needle: string): number {
  if (needle === '') return 0
  return haystack.split(needle).length - 1
}

function normalizePatchEntries (raw: unknown): PatchEntry[] {
  if (!Array.isArray(raw)) {
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) return normalizePatchEntries(parsed)
      } catch { /* fall through */ }
    }
    throw new Error('patches must be an array of { start_line, end_line, content } objects.')
  }

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`patches[${index}] must be an object with start_line, end_line, and content.`)
    }
    const value = entry as Record<string, unknown>
    const startLine = Number(value.start_line)
    const endLine = Number(value.end_line)
    if (!Number.isFinite(startLine) || startLine < 1) {
      throw new Error(`patches[${index}].start_line must be a positive integer.`)
    }
    if (!Number.isFinite(endLine)) {
      throw new Error(`patches[${index}].end_line must be an integer.`)
    }
    if (typeof value.content !== 'string') {
      throw new Error(`patches[${index}].content must be a string.`)
    }
    return { start_line: Math.floor(startLine), end_line: Math.floor(endLine), content: value.content }
  })
}

export function toolListWorkspaceFiles (services: ToolServices): Tool {
  return {
    definition: {
      name: 'list_workspace_files',
      description: 'List files and folders in the selected conversation folder workspace. Paths are relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          dir_path: {
            type: 'string',
            description: 'Directory path relative to the workspace root. Defaults to the root.'
          }
        }
      }
    },
    handler: async (args, onProgress) => {
      const { dir_path } = args as unknown as ListWorkspaceFilesArgs
      const requestedDir = normalizeWorkspaceRelativePath(dir_path)
      onProgress?.('Listing workspace files', requestedDir || '.')
      const listing = await listFolderWorkspaceFiles(services.workspaceRoot)
      if (!requestedDir) return listing

      const segments = requestedDir.split('/').filter(Boolean)
      let entries = listing.entries
      let found = false
      for (const segment of segments) {
        const next = entries.find(item => item.type === 'directory' && item.name === segment)
        if (!next) {
          entries = []
          found = false
          break
        }
        entries = next.children || []
        found = true
      }

      return {
        rootPath: listing.rootPath,
        rootName: listing.rootName,
        dir_path: requestedDir,
        entries: found ? entries : [],
        totalEntries: entries.length,
        truncated: listing.truncated
      }
    }
  }
}

export function toolReadWorkspaceFile (services: ToolServices, readTracker?: ReadFileTracker): Tool {
  return {
    definition: {
      name: 'read_workspace_file',
      description: [
        'Read a file from the selected folder workspace. Large files can be read in line-based segments via start_line / max_lines.',
        'Results are returned in cat -n format with absolute 1-based line numbers. Do not include line-number prefixes when editing.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path relative to the workspace root' },
          start_line: { type: 'integer', description: 'Start line number (1-based).' },
          max_lines: { type: 'integer', description: `Maximum lines to read. Default ${DEFAULT_SEGMENT_LINES}, maximum ${MAX_SEGMENT_LINES}.` }
        },
        required: ['file_path']
      }
    },
    handler: async (args) => {
      const { file_path, start_line, max_lines } = args as unknown as ReadWorkspaceFileArgs
      const preview = await readFolderWorkspaceFile(services.workspaceRoot, file_path)
      const content = preview.content

      readTracker?.markRead(workspaceTrackerId(preview.rootPath), preview.filePath)

      const lines = content === '' ? [] : content.split('\n')
      const totalLines = lines.length
      if (totalLines === 0) {
        return {
          file_path: preview.filePath,
          content: '(This file exists but is empty - 0 lines.)',
          truncated: preview.truncated,
          total_chars: 0,
          total_lines: 0,
          start_line: 0,
          end_line: 0,
          has_more: false,
          next_start_line: null
        }
      }

      const normalizedStartLine = Math.max(1, Math.floor(start_line || 1))
      const requestedMaxLines = Math.min(
        MAX_SEGMENT_LINES,
        Math.max(1, Math.floor(max_lines || (content.length > MAX_RETURN_CHARS ? DEFAULT_SEGMENT_LINES : totalLines)))
      )
      const startIndex = Math.min(normalizedStartLine - 1, Math.max(0, totalLines - 1))
      const endIndexExclusive = Math.min(totalLines, startIndex + requestedMaxLines)
      const selectedLines = lines.slice(startIndex, endIndexExclusive)
      const startLineNumber = startIndex + 1
      const endLineNumber = startIndex + selectedLines.length
      const numberedContent = renderWithLineNumbers(selectedLines, startLineNumber)
      const hasMore = endIndexExclusive < totalLines || preview.truncated
      const nextStartLine = hasMore && endIndexExclusive < totalLines ? endIndexExclusive + 1 : null

      if (numberedContent.length <= MAX_RETURN_CHARS) {
        return {
          file_path: preview.filePath,
          content: numberedContent,
          truncated: preview.truncated,
          total_chars: content.length,
          total_lines: totalLines,
          start_line: startLineNumber,
          end_line: endLineNumber,
          has_more: hasMore,
          next_start_line: nextStartLine
        }
      }

      const head = numberedContent.slice(0, EDGE_RETURN_CHARS)
      const tail = numberedContent.slice(-EDGE_RETURN_CHARS)
      const truncatedChars = Math.max(0, numberedContent.length - (EDGE_RETURN_CHARS * 2))
      return {
        file_path: preview.filePath,
        content: `${head}\n\n...[truncated ${truncatedChars} characters within requested segment lines ${startLineNumber}-${endLineNumber}; narrow the range with start_line / max_lines to read the middle]...\n\n${tail}`,
        truncated: true,
        total_chars: content.length,
        total_lines: totalLines,
        start_line: startLineNumber,
        end_line: endLineNumber,
        has_more: hasMore,
        next_start_line: nextStartLine
      }
    }
  }
}

export function toolWriteWorkspaceFile (services: ToolServices, readTracker?: ReadFileTracker): Tool {
  return {
    definition: {
      name: 'write_workspace_file',
      description: 'Create or rewrite a file in the selected folder workspace. Use targeted edit tools for small changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path relative to the workspace root' },
          content: { type: 'string', description: 'Full file content' }
        },
        required: ['file_path', 'content']
      }
    },
    handler: async (args, onProgress) => {
      const { file_path, content } = args as unknown as WriteWorkspaceFileArgs
      let previousContent: string | undefined
      try {
        previousContent = await readWorkspaceTextFileFull(services.workspaceRoot, file_path)
      } catch {
        previousContent = undefined
      }
      await streamFilePreview(file_path, content, onProgress, previousContent)
      onProgress?.('Writing workspace file', file_path)
      await writeFolderWorkspaceFile(services.workspaceRoot, file_path, content)
      readTracker?.markRead(workspaceTrackerId(services.workspaceRoot), normalizeWorkspaceRelativePath(file_path))
      return { success: true, file_path: normalizeWorkspaceRelativePath(file_path) }
    }
  }
}

export function toolEditWorkspaceFile (services: ToolServices, readTracker?: ReadFileTracker): Tool {
  return {
    definition: {
      name: 'edit_workspace_file',
      description: [
        'Perform exact string replacements in a workspace file. This is preferred for targeted edits.',
        'You must read the file with read_workspace_file earlier in this session. old_string must match exactly and must not include line-number prefixes.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path relative to the workspace root' },
          old_string: { type: 'string', description: 'Exact text to replace. Must be unique unless replace_all is true.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring a unique match.' }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    },
    handler: async (args, onProgress) => {
      const { file_path, old_string, new_string, replace_all } = args as unknown as EditWorkspaceFileArgs
      const normalized = normalizeWorkspaceRelativePath(file_path)
      if (!old_string) throw new Error('old_string must not be empty. To create a new file, use write_workspace_file instead.')
      if (old_string === new_string) throw new Error('old_string and new_string are identical - nothing to change.')
      if (readTracker && !readTracker.hasRead(workspaceTrackerId(services.workspaceRoot), normalized)) {
        throw new Error(`You must read ${normalized} with read_workspace_file before editing it.`)
      }

      onProgress?.('Reading workspace file', normalized)
      const originalContent = await readWorkspaceTextFileFull(services.workspaceRoot, normalized)
      const occurrences = countOccurrences(originalContent, old_string)
      if (occurrences === 0) {
        throw new Error(`old_string was not found in ${normalized}. Re-read the file and copy the exact snippet without line numbers.`)
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(`old_string is not unique in ${normalized} (${occurrences} matches). Add context or set replace_all: true.`)
      }

      const newContent = replace_all
        ? originalContent.split(old_string).join(new_string)
        : originalContent.slice(0, originalContent.indexOf(old_string)) + new_string + originalContent.slice(originalContent.indexOf(old_string) + old_string.length)
      await streamFilePreview(normalized, newContent, onProgress, originalContent)
      await writeFolderWorkspaceFile(services.workspaceRoot, normalized, newContent)
      readTracker?.markRead(workspaceTrackerId(services.workspaceRoot), normalized)
      return { success: true, file_path: normalized, replacements: replace_all ? occurrences : 1 }
    }
  }
}

export function toolPatchWorkspaceFile (services: ToolServices, readTracker?: ReadFileTracker): Tool {
  return {
    definition: {
      name: 'patch_workspace_file',
      description: 'Apply line-range patches to a workspace file. Patches are applied bottom-to-top and must not overlap.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path relative to the workspace root' },
          patches: {
            type: 'array',
            description: 'Array of { start_line, end_line, content } patches. Lines are 1-based inclusive; end_line < start_line inserts before start_line.',
            items: {
              type: 'object',
              properties: {
                start_line: { type: 'integer' },
                end_line: { type: 'integer' },
                content: { type: 'string' }
              },
              required: ['start_line', 'end_line', 'content']
            }
          }
        },
        required: ['file_path', 'patches']
      }
    },
    handler: async (args, onProgress) => {
      const { file_path } = args as unknown as PatchWorkspaceFileArgs
      const normalized = normalizeWorkspaceRelativePath(file_path)
      const patches = normalizePatchEntries((args as Record<string, unknown>).patches)
      if (patches.length === 0) throw new Error('patch_workspace_file requires at least one patch entry.')

      const originalContent = await readWorkspaceTextFileFull(services.workspaceRoot, normalized)
      const lines = originalContent.split('\n')
      const totalLines = lines.length
      const sortedPatches = [...patches].sort((a, b) => b.start_line - a.start_line)

      for (let i = 0; i < sortedPatches.length - 1; i++) {
        const current = sortedPatches[i]
        const next = sortedPatches[i + 1]
        const currentEffectiveStart = Math.max(1, current.start_line)
        const nextEffectiveEnd = next.end_line < next.start_line ? next.start_line - 1 : next.end_line
        if (nextEffectiveEnd >= currentEffectiveStart) {
          throw new Error(`Patches overlap: lines ${next.start_line}-${next.end_line} and ${current.start_line}-${current.end_line}.`)
        }
      }

      for (const patch of sortedPatches) {
        const startIdx = Math.max(0, patch.start_line - 1)
        const isInsert = patch.end_line < patch.start_line
        const endIdx = isInsert ? startIdx : Math.min(totalLines, patch.end_line)
        const newLines = patch.content === '' ? [] : patch.content.split('\n')
        if (isInsert) lines.splice(startIdx, 0, ...newLines)
        else lines.splice(startIdx, endIdx - startIdx, ...newLines)
      }

      const newContent = lines.join('\n')
      await streamFilePreview(normalized, newContent, onProgress, originalContent)
      onProgress?.('Writing workspace file', `${patches.length} patches`)
      await writeFolderWorkspaceFile(services.workspaceRoot, normalized, newContent)
      readTracker?.markRead(workspaceTrackerId(services.workspaceRoot), normalized)
      return { success: true, file_path: normalized, patches_applied: patches.length, original_lines: totalLines, new_lines: lines.length }
    }
  }
}

export function toolDeleteWorkspaceFile (services: ToolServices): Tool {
  return {
    definition: {
      name: 'delete_workspace_file',
      description: 'Delete a file from the selected folder workspace.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path relative to the workspace root' }
        },
        required: ['file_path']
      }
    },
    handler: async (args, onProgress) => {
      const { file_path } = args as unknown as DeleteWorkspaceFileArgs
      const normalized = normalizeWorkspaceRelativePath(file_path)
      onProgress?.('Deleting workspace file', normalized)
      await deleteFolderWorkspaceFile(services.workspaceRoot, normalized)
      return { success: true, file_path: normalized }
    }
  }
}

function includePatternToRegex (pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function escapeRegex (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function collectSearchFiles (baseDir: string, currentRelative: string, includeRegex: RegExp | null, result: string[]): Promise<void> {
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
      await collectSearchFiles(baseDir, currentRelative ? `${currentRelative}/${entry.name}` : entry.name, includeRegex, result)
      continue
    }

    const ext = path.extname(entry.name).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) continue
    const relativePath = currentRelative ? `${currentRelative}/${entry.name}` : entry.name
    if (includeRegex && !includeRegex.test(entry.name)) continue
    result.push(relativePath)
  }
}

async function scanFileForGrep (
  filePath: string,
  relativePath: string,
  searchRegex: RegExp,
  mode: GrepOutputMode,
  contextLines: number,
  contentMatchLimit: number
): Promise<{ matched: boolean; count: number; matches: GrepMatch[] } | null> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_SEARCH_FILE_SIZE_BYTES) return null
  } catch {
    return null
  }

  const allLines: string[] = []
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })
    for await (const line of rl) allLines.push(line)
  } catch {
    return null
  }

  let count = 0
  const matches: GrepMatch[] = []
  for (let i = 0; i < allLines.length; i++) {
    searchRegex.lastIndex = 0
    if (!searchRegex.test(allLines[i])) continue
    count++
    if (mode === 'files_with_matches') return { matched: true, count: 1, matches: [] }
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

export function toolGrepWorkspace (services: ToolServices): Tool {
  return {
    definition: {
      name: 'grep_workspace',
      description: 'Search text or regex patterns inside the selected folder workspace.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search text or regex pattern' },
          dir_path: { type: 'string', description: 'Directory to search within, relative to workspace root.' },
          include_pattern: { type: 'string', description: 'Only search files matching this pattern, e.g. "*.ts".' },
          is_regexp: { type: 'boolean', description: 'Whether pattern is a regular expression.' },
          case_sensitive: { type: 'boolean', description: 'Whether search is case-sensitive.' },
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
          max_results: { type: 'integer', description: `Default ${DEFAULT_GREP_MAX_RESULTS}, max ${MAX_GREP_RESULTS}.` },
          context_lines: { type: 'integer', description: `Default ${DEFAULT_CONTEXT_LINES}, max ${MAX_CONTEXT_LINES}.` }
        },
        required: ['pattern']
      }
    },
    handler: async (args, onProgress) => {
      const { pattern, dir_path, include_pattern, is_regexp, case_sensitive, output_mode, max_results, context_lines } = args as unknown as GrepWorkspaceArgs
      const mode: GrepOutputMode = output_mode === 'files_with_matches' || output_mode === 'count' ? output_mode : 'content'
      const limit = Math.min(Math.max(1, max_results || DEFAULT_GREP_MAX_RESULTS), MAX_GREP_RESULTS)
      const ctxLines = Math.min(Math.max(0, context_lines ?? DEFAULT_CONTEXT_LINES), MAX_CONTEXT_LINES)
      const searchDir = normalizeWorkspaceRelativePath(dir_path)
      const flags = case_sensitive === true ? '' : 'i'
      const searchRegex = is_regexp ? new RegExp(pattern, flags) : new RegExp(escapeRegex(pattern), flags)
      const includeRegex = include_pattern ? includePatternToRegex(include_pattern) : null

      onProgress?.('Searching workspace', pattern)
      const baseDir = resolveFolderWorkspacePath(services.workspaceRoot, searchDir)
      const filePaths: string[] = []
      await collectSearchFiles(baseDir, '', includeRegex, filePaths)

      const contentMatches: GrepMatch[] = []
      const matchedFiles: string[] = []
      const counts: Array<{ file: string; count: number }> = []
      let filesMatched = 0
      let totalMatches = 0
      let stoppedEarly = false

      for (const relativePath of filePaths) {
        const reachedCap = mode === 'content' ? contentMatches.length >= limit : filesMatched >= limit
        if (reachedCap) {
          stoppedEarly = true
          break
        }
        const result = await scanFileForGrep(path.join(baseDir, relativePath), relativePath, searchRegex, mode, ctxLines, limit - contentMatches.length)
        if (!result || !result.matched) continue
        filesMatched++
        totalMatches += result.count
        if (mode === 'content') contentMatches.push(...result.matches.slice(0, limit - contentMatches.length))
        else if (mode === 'files_with_matches') matchedFiles.push(relativePath)
        else counts.push({ file: relativePath, count: result.count })
      }

      return {
        pattern,
        dir_path: searchDir || '.',
        output_mode: mode,
        case_sensitive: case_sensitive === true,
        matches: mode === 'content' ? contentMatches : undefined,
        files: mode === 'files_with_matches' ? matchedFiles : undefined,
        counts: mode === 'count' ? counts : undefined,
        total_matches: totalMatches,
        files_searched: filePaths.length,
        files_matched: filesMatched,
        truncated: stoppedEarly
      }
    }
  }
}

function globToRegex (pattern: string): RegExp {
  let reStr = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        reStr += '.*'
        i += 2
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
        const group = pattern.slice(i + 1, close).split(',').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
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
      reStr += /[.+^${}()|\\]/.test(ch) ? `\\${ch}` : ch
      i++
    }
  }
  return new RegExp(`^${reStr}$`, 'i')
}

async function walkGlob (baseDir: string, regex: RegExp, currentRelative: string, results: GlobMatch[], limit: number): Promise<void> {
  if (results.length >= limit) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(path.join(baseDir, currentRelative), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (results.length >= limit) return
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
    const entryRelative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (regex.test(entryRelative) || regex.test(`${entryRelative}/`)) {
        results.push({ path: entryRelative, size: 0, type: 'directory' })
      }
      await walkGlob(baseDir, regex, entryRelative, results, limit)
    } else if (regex.test(entryRelative)) {
      let size = 0
      try {
        size = (await fs.stat(path.join(baseDir, entryRelative))).size
      } catch { /* ignore */ }
      results.push({ path: entryRelative, size, type: 'file' })
    }
  }
}

export function toolGlobWorkspace (services: ToolServices): Tool {
  return {
    definition: {
      name: 'glob_workspace',
      description: 'Search for files in the selected folder workspace using glob patterns like "**/*.ts".',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match relative file paths.' },
          dir_path: { type: 'string', description: 'Directory to search within, relative to workspace root.' },
          max_results: { type: 'integer', description: `Default ${DEFAULT_GLOB_MAX_RESULTS}, max ${MAX_GLOB_RESULTS}.` }
        },
        required: ['pattern']
      }
    },
    handler: async (args, onProgress) => {
      const { pattern, dir_path, max_results } = args as unknown as GlobWorkspaceArgs
      const limit = Math.min(Math.max(1, max_results || DEFAULT_GLOB_MAX_RESULTS), MAX_GLOB_RESULTS)
      const searchDir = normalizeWorkspaceRelativePath(dir_path)
      const baseDir = resolveFolderWorkspacePath(services.workspaceRoot, searchDir)
      const matches: GlobMatch[] = []
      onProgress?.('Finding workspace files', pattern)
      await walkGlob(baseDir, globToRegex(pattern), '', matches, limit + 1)
      const truncated = matches.length > limit
      return {
        pattern,
        dir_path: searchDir || '.',
        matches: matches.slice(0, limit),
        total_matches: truncated ? limit + 1 : matches.length,
        truncated
      }
    }
  }
}

export function toolRunWorkspaceCommand (services: ToolServices): Tool {
  return {
    definition: {
      name: 'run_workspace_command',
      description: 'Run a short-lived install, build, test, lint, type-check, or diagnostic command inside the selected folder workspace. Do not start long-lived dev servers.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run, e.g. "npm test", "pnpm build", "npx tsc --noEmit".' },
          cwd: { type: 'string', description: 'Working subdirectory relative to the workspace root.' },
          timeout_seconds: { type: 'integer', description: `Foreground wait timeout. Default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}.` }
        },
        required: ['command']
      }
    },
    handler: async (args, onProgress) => {
      const { command, cwd, timeout_seconds } = args as unknown as RunWorkspaceCommandArgs
      validateProjectLikeCommand(command)
      const timeoutSeconds = Math.min(Math.max(timeout_seconds || DEFAULT_TIMEOUT_SECONDS, 5), MAX_TIMEOUT_SECONDS)
      const workspaceRoot = path.resolve(services.workspaceRoot)
      const workDir = cwd ? resolveFolderWorkspacePath(workspaceRoot, cwd) : workspaceRoot
      const relativeWorkDir = path.relative(workspaceRoot, workDir)
      if (relativeWorkDir.startsWith('..') || path.isAbsolute(relativeWorkDir)) {
        throw new Error('Working directory must be within the selected workspace.')
      }

      onProgress?.('Running workspace command', `${command} (${timeoutSeconds}s)`)
      const env = await createBundledRuntimeEnv(workDir, {
        CI: 'true',
        GIT_TERMINAL_PROMPT: '0',
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false'
      })

      return await new Promise((resolve) => {
        const child = spawn(command, [], {
          cwd: workDir,
          shell: true,
          env,
          windowsHide: true,
          detached: process.platform !== 'win32'
        })

        const record: WorkspaceCommandExecutionRecord = {
          command_id: globalThis.crypto?.randomUUID?.() || `wcmd_${Date.now().toString(36)}_${(++commandSequence).toString(36)}`,
          workspace_root: workspaceRoot,
          command,
          cwd: workDir,
          pid: child.pid,
          status: 'running',
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          stdout: '',
          stderr: '',
          timedOut: false,
          outputTruncated: false,
          background: false,
          child
        }
        storeCommandRecord(record)

        let resolved = false
        let outputLimitTerminated = false
        let forceFinalizeHandle: NodeJS.Timeout | null = null
        const startedAt = Date.now()

        const cleanupForegroundTimers = () => {
          clearTimeout(timeoutHandle)
          clearInterval(heartbeatHandle)
          if (forceFinalizeHandle) clearTimeout(forceFinalizeHandle)
        }
        const resolveOnce = (payload: WorkspaceCommandSnapshot) => {
          if (resolved) return
          resolved = true
          cleanupForegroundTimers()
          resolve(payload)
        }
        const finalizeRecord = (status: CommandStatus, reason: CommandReason, exitCode: number | null, signal?: string | null, error?: string) => {
          record.status = status
          record.reason = reason
          record.exitCode = exitCode
          record.signal = signal ?? null
          record.error = error
          record.completed_at = new Date().toISOString()
          record.background = false
          record.message = undefined
          if (!resolved) resolveOnce(toCommandSnapshot(record))
        }
        const appendOutput = (current: string, chunk: Buffer, limit: number) => {
          const next = current + chunk.toString()
          if (next.length <= limit) return { value: next, truncated: false }
          return { value: next.slice(0, limit), truncated: true }
        }
        const terminateForOutputLimit = () => {
          if (outputLimitTerminated) return
          outputLimitTerminated = true
          record.outputTruncated = true
          record.reason = 'output_limit'
          onProgress?.('Workspace command output too long; terminating', command)
          void terminateProcessTree(child.pid)
          forceFinalizeHandle = setTimeout(() => {
            finalizeRecord('failed', 'output_limit', -1, null, 'Command output exceeded the capture limit and was terminated.')
          }, 5000)
        }

        const timeoutHandle = setTimeout(() => {
          record.reason = 'timeout'
          record.timedOut = true
          record.background = true
          record.status = 'running'
          record.message = 'Command exceeded the foreground wait timeout but is still running in the background. Use get_workspace_command_status with this command_id before retrying.'
          onProgress?.('Workspace command moved to background after timeout', `${timeoutSeconds}s: ${command}`)
          resolveOnce(toCommandSnapshot(record))
        }, timeoutSeconds * 1000)

        const heartbeatHandle = setInterval(() => {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          onProgress?.('Workspace command still running', `${elapsedSeconds}s: ${command}`)
        }, HEARTBEAT_INTERVAL_MS)

        child.stdout?.on('data', (data: Buffer) => {
          const next = appendOutput(record.stdout, data, MAX_STDOUT_CHARS)
          record.stdout = next.value
          record.outputTruncated = record.outputTruncated || next.truncated
          if (next.truncated) terminateForOutputLimit()
        })
        child.stderr?.on('data', (data: Buffer) => {
          const next = appendOutput(record.stderr, data, MAX_STDERR_CHARS)
          record.stderr = next.value
          record.outputTruncated = record.outputTruncated || next.truncated
          if (next.truncated) terminateForOutputLimit()
        })
        child.on('close', (code, signal) => {
          if (outputLimitTerminated) {
            finalizeRecord('failed', 'output_limit', code ?? -1, signal, 'Command output exceeded the capture limit and was terminated.')
            return
          }
          const status = code === 0 ? 'completed' : 'failed'
          onProgress?.('Workspace command completed', `exit code: ${String(code ?? 0)}`)
          finalizeRecord(status, 'completed', code, signal, code === 0 ? undefined : `Command exited with code ${String(code)}`)
        })
        child.on('error', (err) => {
          onProgress?.('Workspace command failed', err.message)
          finalizeRecord('failed', 'spawn_error', -1, null, `Command failed: ${err.message}`)
        })
      })
    }
  }
}

export function toolGetWorkspaceCommandStatus (): Tool {
  return {
    definition: {
      name: 'get_workspace_command_status',
      description: 'Get the latest status and output for a command started by run_workspace_command.',
      parameters: {
        type: 'object',
        properties: {
          command_id: { type: 'string', description: 'Command execution ID returned by run_workspace_command' }
        },
        required: ['command_id']
      }
    },
    handler: async (args) => {
      const { command_id } = args as unknown as GetWorkspaceCommandStatusArgs
      const record = commandHistory.get(command_id)
      if (!record) throw new Error(`Workspace command not found: ${command_id}`)
      return toCommandSnapshot(record)
    }
  }
}

function storeCommandRecord (record: WorkspaceCommandExecutionRecord): void {
  commandHistory.set(record.command_id, record)
  if (commandHistory.size <= MAX_COMMAND_HISTORY) return
  const removableIds = Array.from(commandHistory.values())
    .filter(record => record.status !== 'running')
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map(record => record.command_id)
  while (commandHistory.size > MAX_COMMAND_HISTORY && removableIds.length > 0) {
    const id = removableIds.shift()
    if (!id) break
    commandHistory.delete(id)
  }
}

function toCommandSnapshot (record: WorkspaceCommandExecutionRecord): WorkspaceCommandSnapshot {
  return {
    command_id: record.command_id,
    workspace_root: record.workspace_root,
    command: record.command,
    cwd: record.cwd,
    pid: record.pid,
    status: record.status,
    reason: record.reason,
    created_at: record.created_at,
    started_at: record.started_at,
    completed_at: record.completed_at,
    exitCode: record.exitCode,
    signal: record.signal,
    stdout: record.stdout,
    stderr: record.stderr,
    timedOut: record.timedOut,
    outputTruncated: record.outputTruncated,
    background: record.background,
    message: record.message,
    error: record.error
  }
}

function validateProjectLikeCommand (rawCommand: string): ParsedCommand {
  const command = rawCommand.trim()
  if (!command) throw new Error('Command must not be empty.')
  if (/[\r\n]/.test(command)) throw new Error('Run a single logical command without newlines.')
  if (/`|\$\(/.test(command)) throw new Error('Command substitution is not allowed.')
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error('Command was blocked as potentially destructive.')
    }
  }

  const developerMode = isDeveloperCommandModeEnabled()
  const hasShellOperators = /[;&|<>]/.test(command)
  if (hasShellOperators && !developerMode) {
    throw new Error('Command contains shell operators. Run one command per call or enable THE_WORLD_DEV_COMMANDS=1.')
  }

  const segments = developerMode ? splitCommandSegments(command) : [command]
  let firstParsed: ParsedCommand | null = null
  for (const segment of segments) {
    const parsed = validateSingleCommand(segment)
    if (!firstParsed) firstParsed = parsed
  }
  if (!firstParsed) throw new Error('Command must not be empty.')
  return firstParsed
}

function validateSingleCommand (segment: string): ParsedCommand {
  const tokens = tokenizeCommand(segment)
  if (tokens.length === 0) throw new Error('Command must not be empty.')
  const baseCommand = normalizeBaseCommand(tokens[0])
  if (!PROJECT_COMMAND_WHITELIST.includes(baseCommand)) {
    throw new Error(`Command not allowed: ${baseCommand}. Allowed: ${PROJECT_COMMAND_WHITELIST.join(', ')}.`)
  }
  if (baseCommand === 'npm') validateNpmCommand(tokens)
  else if (baseCommand === 'git') validateGitCommand(tokens)
  return { baseCommand, tokens }
}

function splitCommandSegments (command: string): string[] {
  return stripRedirections(command)
    .split(/\s*(?:&&|\|\||;|\||&)\s*/)
    .map(segment => segment.trim())
    .filter(Boolean)
}

function stripRedirections (text: string): string {
  return text
    .replace(/\d*>>?\s*&\s*\d+/g, ' ')
    .replace(/\d*>>?\s*\S+/g, ' ')
    .replace(/<\s*\S+/g, ' ')
    .trim()
}

function tokenizeCommand (command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map(token => token.replace(/^("|')|("|')$/g, ''))
}

function normalizeBaseCommand (token: string): string {
  return path.basename(token).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase()
}

function validateNpmCommand (tokens: string[]): void {
  const subCommand = tokens[1]?.toLowerCase()
  if (!subCommand) throw new Error('npm command requires a subcommand.')
  if (subCommand === 'install' || subCommand === 'i' || subCommand === 'ci' || subCommand === 'test') return
  if (subCommand === 'run') {
    const scriptName = tokens[2]?.toLowerCase()
    if (!scriptName) throw new Error('npm run requires a script name.')
    if (LONG_RUNNING_NPM_SCRIPTS.has(scriptName)) {
      throw new Error(`npm run ${scriptName} is long-running. Do not use run_workspace_command for dev servers.`)
    }
    return
  }
  throw new Error('npm command is not allowed here.')
}

function validateGitCommand (tokens: string[]): void {
  const subCommand = tokens[1]?.toLowerCase() || 'status'
  if (!SAFE_GIT_SUBCOMMANDS.has(subCommand)) {
    throw new Error(`git ${subCommand} is not allowed. Allowed git subcommands: ${Array.from(SAFE_GIT_SUBCOMMANDS).join(', ')}.`)
  }
}

async function terminateProcessTree (pid?: number): Promise<void> {
  if (!pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on('close', () => resolve())
      killer.on('error', () => {
        try {
          process.kill(pid)
        } catch { /* ignore */ }
        resolve()
      })
    })
    return
  }
  try {
    process.kill(-pid)
  } catch {
    try {
      process.kill(pid)
    } catch { /* ignore */ }
  }
}
