import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

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
// reads for later segments of large files.
const MAX_RETURN_CHARS = 40000
const EDGE_RETURN_CHARS = 20000
const DEFAULT_SEGMENT_LINES = 200
const MAX_SEGMENT_LINES = 400

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

/**
 * Tool: read_project_file — 读取指定项目的文件内容
 */
export function toolReadFile (services: ToolServices): Tool {
  return {
    definition: {
      name: 'read_project_file',
      description: 'Read file content from the specified project. Large files can be read in line-based segments.',
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
      const lines = content === '' ? [] : content.split('\n')
      const totalLines = lines.length
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
      const selectedLines = totalLines === 0 ? [] : lines.slice(startIndex, endIndexExclusive)
      const selectedContent = selectedLines.join('\n')
      const startLineNumber = totalLines === 0 ? 0 : startIndex + 1
      const endLineNumber = totalLines === 0 ? 0 : startIndex + selectedLines.length
      const hasMore = endIndexExclusive < totalLines
      const nextStartLine = hasMore ? endIndexExclusive + 1 : null

      if (selectedContent.length <= MAX_RETURN_CHARS) {
        return {
          file_path,
          content: selectedContent,
          truncated: false,
          total_chars: content.length,
          total_lines: totalLines,
          start_line: startLineNumber,
          end_line: endLineNumber,
          has_more: hasMore,
          next_start_line: nextStartLine
        }
      }

      const head = selectedContent.slice(0, EDGE_RETURN_CHARS)
      const tail = selectedContent.slice(-EDGE_RETURN_CHARS)
      const truncatedChars = Math.max(0, selectedContent.length - (EDGE_RETURN_CHARS * 2))

      return {
        file_path,
        content: `${head}\n\n...[truncated ${truncatedChars} characters within requested segment lines ${startLineNumber}-${endLineNumber}]...\n\n${tail}`,
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
