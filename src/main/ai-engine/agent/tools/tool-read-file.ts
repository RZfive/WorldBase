import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface ReadFileArgs {
  project_id: string
  file_path: string
}

interface ReadFileResult {
  file_path: string
  content: string
  truncated: boolean
  total_chars: number
}

const MAX_RETURN_CHARS = 40000
const EDGE_RETURN_CHARS = 20000

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
      description: '读取指定项目的文件内容。用于理解项目代码结构。',
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
          }
        },
        required: ['project_id', 'file_path']
      }
    },
    handler: async (args): Promise<ReadFileResult> => {
      const { project_id, file_path } = args as unknown as ReadFileArgs
      const content = await services.projectFS.readFile(project_id, file_path)
      if (content.length <= MAX_RETURN_CHARS) {
        return { file_path, content, truncated: false, total_chars: content.length }
      }

      const head = content.slice(0, EDGE_RETURN_CHARS)
      const tail = content.slice(-EDGE_RETURN_CHARS)

      return {
        file_path,
        content: `${head}\n\n...[truncated ${content.length - (EDGE_RETURN_CHARS * 2)} characters]...\n\n${tail}`,
        truncated: true,
        total_chars: content.length
      }
    }
  }
}
