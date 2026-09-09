import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ReadFileTracker } from './read-tracker.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface ReadFileArgs {
  project_id: string
  file_path: string
  start_line?: number
  max_lines?: number
}

interface ReadFileResult {
  file_path: string
  content: string
  truncated: boolean
  total_chars: number
  total_lines: number
  start_line: number
  end_line: number
  has_more: boolean
  next_start_line: number | null
}

// Keep tool responses small enough for the agent loop, while allowing follow-up
// reads for later segments of large files. Defaults are generous so small and
// medium files are read in full in a single call (fewer round-trips), while a
// hard character cap still protects the context window for very large files.
const MAX_RETURN_CHARS = 50000
const EDGE_RETURN_CHARS = 25000
const DEFAULT_SEGMENT_LINES = 1000
const MAX_SEGMENT_LINES = 2000

/** Width of the right-aligned line-number gutter in the cat -n style output. */
const LINE_NUMBER_WIDTH = 6

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

/**
 * Render selected lines in `cat -n` style: a right-aligned line number, a tab,
 * then the original line content. Line numbers are 1-based and absolute (they
 * reflect the real position in the file, not the position within the segment).
 */
function renderWithLineNumbers (lines: string[], firstLineNumber: number): string {
  return lines
    .map((line, i) => `${String(firstLineNumber + i).padStart(LINE_NUMBER_WIDTH)}\t${line}`)
    .join('\n')
}

/**
 * Tool: read_project_file — 读取指定项目的文件内容
 */
export function toolReadFile (services: ToolServices, readTracker?: ReadFileTracker): Tool {
  return {
    definition: {
      name: 'read_project_file',
      description: [
        'Read file content from the specified project. Large files can be read in line-based segments via start_line / max_lines.',
        'Results are returned in `cat -n` format: each line is prefixed with a right-aligned line number and a tab, then the original content. Line numbers are 1-based and absolute within the file.',
        'When you later edit this file (edit_project_file / patch_project_file), do NOT include the line-number + tab prefix — match or write only the real file content that follows it.',
        `Defaults read up to ${DEFAULT_SEGMENT_LINES} lines (max ${MAX_SEGMENT_LINES}); small and medium files are returned in full in one call.`
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          file_path: {
            type: 'string',
            description: 'File path relative to the project root'
          },
          start_line: {
            type: 'integer',
            description: 'Start line number (1-based). Use segments for large files.'
          },
          max_lines: {
            type: 'integer',
            description: `Maximum lines to read. Default ${DEFAULT_SEGMENT_LINES}, maximum ${MAX_SEGMENT_LINES}.`
          }
        },
        required: ['project_id', 'file_path']
      }
    },
    handler: async (args): Promise<ReadFileResult> => {
      const { project_id, file_path, start_line, max_lines } = args as unknown as ReadFileArgs
      const content = await services.projectFS.readFile(project_id, file_path)

      // Mark the file as seen so exact-string edits are allowed against it.
      readTracker?.markRead(project_id, file_path)

      const lines = content === '' ? [] : content.split('\n')
      const totalLines = lines.length

      // Empty file: return an explicit, unambiguous notice instead of blank content.
      if (totalLines === 0) {
        return {
          file_path,
          content: '(This file exists but is empty — 0 lines.)',
          truncated: false,
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
        Math.max(
          1,
          Math.floor(
            max_lines ||
            (content.length > MAX_RETURN_CHARS ? DEFAULT_SEGMENT_LINES : totalLines)
          )
        )
      )
      const startIndex = Math.min(normalizedStartLine - 1, Math.max(0, totalLines - 1))
      const endIndexExclusive = Math.min(totalLines, startIndex + requestedMaxLines)
      const selectedLines = lines.slice(startIndex, endIndexExclusive)
      const startLineNumber = startIndex + 1
      const endLineNumber = startIndex + selectedLines.length
      const numberedContent = renderWithLineNumbers(selectedLines, startLineNumber)
      const hasMore = endIndexExclusive < totalLines
      const nextStartLine = hasMore ? endIndexExclusive + 1 : null

      if (numberedContent.length <= MAX_RETURN_CHARS) {
        return {
          file_path,
          content: numberedContent,
          truncated: false,
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
        file_path,
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
