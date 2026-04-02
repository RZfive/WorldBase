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
      description: '读取指定项目的文件内容。支持按行分段读取大文件，用于理解项目代码结构。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目 ID'
          },
          file_path: {
            type: 'string',
            description: '相对于项目根目录的文件路径'
          },
          start_line: {
            type: 'integer',
            description: '起始行号（从 1 开始）。大文件建议分段读取。'
          },
          max_lines: {
            type: 'integer',
            description: `最多读取的行数。默认 ${DEFAULT_SEGMENT_LINES} 行，最大 ${MAX_SEGMENT_LINES} 行。`
          }
        },
        required: ['project_id', 'file_path']
      }
    },
    handler: async (args): Promise<ReadFileResult> => {
      const { project_id, file_path, start_line, max_lines } = args as unknown as ReadFileArgs
      const content = await services.projectFS.readFile(project_id, file_path)
      const lines = content.split('\n')
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
      const selectedLines = lines.slice(startIndex, endIndexExclusive)
      const selectedContent = selectedLines.join('\n')
      const startLineNumber = totalLines === 0 ? 1 : startIndex + 1
      const endLineNumber = totalLines === 0 ? 1 : startIndex + selectedLines.length
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

      return {
        file_path,
        content: `${head}\n\n...[truncated ${selectedContent.length - (EDGE_RETURN_CHARS * 2)} characters from lines ${startLineNumber}-${endLineNumber}]...\n\n${tail}`,
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
